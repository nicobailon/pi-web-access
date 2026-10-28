import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

// SearchApi Google Search API: https://www.searchapi.io/docs/google
const SEARCHAPI_SEARCH_URL = "https://www.searchapi.io/api/v1/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const RECENCY_TIME_PERIOD: Record<NonNullable<SearchOptions["recencyFilter"]>, string> = {
	day: "last_day",
	week: "last_week",
	month: "last_month",
	year: "last_year",
};

interface WebSearchConfig {
	searchapiBaseUrl?: unknown;
	searchapiApiKey?: unknown;
}

interface SearchApiOrganicResult {
	title?: unknown;
	link?: unknown;
	snippet?: unknown;
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
		provider: "SearchApi",
		configuredValue: loadConfig().searchapiApiKey,
		environmentValue: process.env.SEARCHAPI_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"SearchApi API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "searchapiApiKey": "your-key" }\n` +
			"  2. Set SEARCHAPI_API_KEY environment variable\n" +
			"Get a key at https://www.searchapi.io",
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

function buildQuery(query: string, filters: DomainFilters): string {
	const parts = [query];
	if (filters.include.length === 1) parts.push(`site:${filters.include[0]}`);
	if (filters.include.length > 1) parts.push(`(${filters.include.map(domain => `site:${domain}`).join(" OR ")})`);
	for (const domain of filters.exclude) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`SearchApi returned invalid response: ${message}`);
}

function parseResponse(value: unknown): SearchApiOrganicResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	// Failures arrive as { "error": "..." }; a 2xx body that carries one is still not a result set.
	if (typeof envelope.error === "string" && envelope.error.trim()) throw invalidResponse(envelope.error.trim());
	if (!Array.isArray(envelope.organic_results)) throw invalidResponse("expected organic_results array");
	return envelope.organic_results as SearchApiOrganicResult[];
}

export function isSearchApiAvailable(): boolean {
	return hasCredentialSource({ provider: "SearchApi", configuredValue: loadConfig().searchapiApiKey, environmentValue: process.env.SEARCHAPI_API_KEY });
}

export async function searchWithSearchApi(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const url = new URL(resolveProviderApiUrl("searchapi", SEARCHAPI_SEARCH_URL, loadConfig().searchapiBaseUrl));
	url.searchParams.set("engine", "google");
	url.searchParams.set("q", buildQuery(query, filters));
	// Google no longer honours `num` (SearchApi documents it as phased out), so one request returns one
	// results page, which is trimmed to numResults locally after the domain filters are reapplied.
	if (options.recencyFilter) url.searchParams.set("time_period", RECENCY_TIME_PERIOD[options.recencyFilter]);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: SearchApiOrganicResult[];
	try {
		response = await fetchWithCredentialRedirects(String(url), {
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": "pi-web-access" },
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SearchApi error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			// Only a parse failure is invalid JSON; a dropped connection or timeout keeps its own classification.
			if (!(err instanceof SyntaxError)) throw err;
			throw new Error(`SearchApi returned invalid JSON: ${errorMessage(err)}`);
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
			? new Error(`SearchApi request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
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
		if (typeof entry.link !== "string" || !entry.link) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(entry.link);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (!passesDomainFilters(resultUrl, filters)) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: typeof entry.snippet === "string" ? entry.snippet : "",
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
