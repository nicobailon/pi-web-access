import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

// Sofya Search API: https://sofya.co/docs
const SOFYA_SEARCH_URL = "https://sofya.co/v1/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_REQUEST_RESULTS = 20;
const MAX_DOMAIN_FILTERS = 10;

interface WebSearchConfig {
	sofyaBaseUrl?: unknown;
	sofyaApiKey?: unknown;
}

interface SofyaHit {
	url?: unknown;
	title?: unknown;
	content?: unknown;
	description?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Sofya",
		configuredValue: loadConfig().sofyaApiKey,
		environmentValue: process.env.SOFYA_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Sofya API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "sofyaApiKey": "your-key" }\n` +
			"  2. Set SOFYA_API_KEY environment variable\n" +
			"Get a key at https://sofya.co/dashboard",
		);
	}
	return apiKey;
}

interface DomainFilters {
	include: string[];
	exclude: string[];
}

function parseDomainFilter(domainFilter: string[] | undefined): DomainFilters {
	const filters: DomainFilters = { include: [], exclude: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.exclude : filters.include;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function passesDomainFilters(url: URL, filters: DomainFilters): boolean {
	if (filters.include.length === 0 && filters.exclude.length === 0) return true;
	const hostname = url.hostname.toLowerCase();
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	if (filters.exclude.some(matches)) return false;
	return filters.include.length === 0 || filters.include.some(matches);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Sofya returned invalid response: ${message}`);
}

function parseResponse(value: unknown): SofyaHit[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (typeof envelope.detail === "string" && envelope.detail.trim()) throw invalidResponse(envelope.detail.trim());
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	return envelope.results as SofyaHit[];
}

export function isSofyaAvailable(): boolean {
	return hasCredentialSource({ provider: "Sofya", configuredValue: loadConfig().sofyaApiKey, environmentValue: process.env.SOFYA_API_KEY });
}

// Domain filters and recency go to Sofya's own include_domains, exclude_domains and freshness.
// "snippets" depth returns title, URL and snippet (1 credit); pages are read with the fetch tool.
export async function searchWithSofya(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const body: Record<string, unknown> = {
		query,
		search_depth: "snippets",
		max_results: Math.min(MAX_REQUEST_RESULTS, numResults),
	};
	if (filters.include.length > 0) body.include_domains = filters.include.slice(0, MAX_DOMAIN_FILTERS);
	if (filters.exclude.length > 0) body.exclude_domains = filters.exclude.slice(0, MAX_DOMAIN_FILTERS);
	if (options.recencyFilter) body.freshness = options.recencyFilter;
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: SofyaHit[];
	try {
		response = await fetchWithCredentialRedirects(resolveProviderApiUrl("sofya", SOFYA_SEARCH_URL, loadConfig().sofyaBaseUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-web-access",
			},
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Sofya error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			// Only a parse failure is invalid JSON; a dropped connection or timeout keeps its own classification.
			if (!(err instanceof SyntaxError)) throw err;
			throw new Error(`Sofya returned invalid JSON: ${errorMessage(err)}`);
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`Sofya request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: (() => {
				const redactedMessage = redactCredential(message, apiKey);
				if (redactedMessage === message && err instanceof Error) return err;
				const redactedError = new Error(redactedMessage);
				if (err instanceof Error) redactedError.name = err.name;
				return redactedError;
			})();
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), apiKey));
		throw outgoing;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.url !== "string" || !entry.url) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(entry.url);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (!passesDomainFilters(resultUrl, filters)) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: typeof entry.content === "string" && entry.content ? entry.content : typeof entry.description === "string" ? entry.description : "",
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
