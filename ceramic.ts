import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";

const CERAMIC_SEARCH_URL = "https://api.ceramic.ai/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_REQUEST_RESULTS = 20;
// Descriptions default to 3,000 characters; 1,000 is the smallest the API accepts. Results
// are trimmed further so ten of them, shown twice (answer and list), fit the inline budget.
const REQUEST_DESCRIPTION_CHARS = 1_000;
const MAX_SNIPPET_CHARS = 500;

interface WebSearchConfig {
	ceramicApiKey?: unknown;
}

interface CeramicResult {
	title?: unknown;
	url?: unknown;
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

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await resolveCredential({
		provider: "Ceramic",
		configuredValue: loadConfig().ceramicApiKey,
		environmentValue: process.env.CERAMIC_API_KEY,
		signal,
	});
	if (!apiKey) {
		throw new Error(
			"Ceramic API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "ceramicApiKey": "your-key" }\n` +
			"  2. Set CERAMIC_API_KEY environment variable\n" +
			"Get a key at https://platform.ceramic.ai/keys",
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

// Ceramic documents `site:`, uppercase `OR`, and parentheses, but not `-site:`, so
// excluded domains are only filtered out of the returned results.
function buildQuery(query: string, filters: DomainFilters): string {
	if (filters.include.length === 0) return query;
	const sites = filters.include.map(domain => `site:${domain}`);
	return `${query} ${sites.length === 1 ? sites[0] : `(${sites.join(" OR ")})`}`;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Ceramic returned invalid response: ${message}`);
}

function parseResponse(value: unknown): CeramicResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const result = (value as Record<string, unknown>).result;
	if (!result || typeof result !== "object" || Array.isArray(result)) throw invalidResponse("expected result object");
	const results = (result as Record<string, unknown>).results;
	if (!Array.isArray(results)) throw invalidResponse("expected result.results array");
	return results as CeramicResult[];
}

// Ceramic errors are `{ title, status, detail, requestId, code }`; show the readable part.
function describeError(body: string): string {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const parts = [text(parsed.title), text(parsed.detail)].filter(Boolean);
		if (parts.length > 0) return parts.join(": ");
	} catch {}
	return body;
}

export function isCeramicAvailable(): boolean {
	return hasCredentialSource({ provider: "Ceramic", configuredValue: loadConfig().ceramicApiKey, environmentValue: process.env.CERAMIC_API_KEY });
}

// Ceramic has no date filter and returns no dates, so `recencyFilter` is not applied.
export async function searchWithCeramic(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	// Results are reapplied to the domain filters locally, so leave a little headroom.
	const hasDomainFilters = filters.include.length > 0 || filters.exclude.length > 0;
	const body = {
		query: buildQuery(query, filters),
		maxResults: hasDomainFilters ? Math.min(MAX_REQUEST_RESULTS, numResults + 5) : numResults,
		maxDescriptionLength: REQUEST_DESCRIPTION_CHARS,
	};
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: CeramicResult[];
	try {
		response = await fetchWithCredentialRedirects(CERAMIC_SEARCH_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = redactCredential(describeError(await response.text()), apiKey).slice(0, 300);
			throw new Error(`Ceramic error ${response.status}: ${errorText}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`Ceramic returned invalid JSON: ${errorMessage(err)}`);
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
			? new Error(`Ceramic request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
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
	const seen = new Set<string>();
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
		if (seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		results.push({
			title: text(entry.title) || `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: text(entry.description).slice(0, MAX_SNIPPET_CHARS),
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
