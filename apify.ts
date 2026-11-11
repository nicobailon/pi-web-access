import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

// Apify Web Search (https://apify.com/apify/web-search) and Web Fetch (https://apify.com/apify/web-fetch)
// Standby Actors. Each request is charged per event to the Apify account and starts no Actor run.
const APIFY_SEARCH_URL = "https://web-search.apify.actor/";
const APIFY_FETCH_URL = "https://web-fetch.apify.actor/";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_QUERY_CHARS = 2_000;
// Web Search accepts up to 10 hostnames in each of allowedDomains and blockedDomains.
const MAX_DOMAIN_FILTERS = 10;
const RECENCY_DAYS: Record<NonNullable<SearchOptions["recencyFilter"]>, number> = {
	day: 1,
	week: 7,
	month: 31,
	year: 366,
};

interface WebSearchConfig {
	apifyApiKey?: unknown;
	apifySearchBaseUrl?: unknown;
	apifyFetchBaseUrl?: unknown;
}

interface ApifySearchResult {
	url?: unknown;
	title?: unknown;
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
		provider: "Apify",
		configuredValue: loadConfig().apifyApiKey,
		environmentValue: process.env.APIFY_TOKEN,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Apify API token not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "apifyApiKey": "your-token" }\n` +
			"  2. Set APIFY_TOKEN environment variable\n" +
			"Get a token at https://console.apify.com/settings/integrations?utm_source=pi-web-access&utm_medium=integrations",
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

function recencyDateFrom(recency: SearchOptions["recencyFilter"], now = new Date()): string | undefined {
	if (!recency) return undefined;
	const from = new Date(now.getTime() - RECENCY_DAYS[recency] * 24 * 60 * 60 * 1000);
	return from.toISOString().slice(0, 10);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Apify returned invalid response: ${message}`);
}

function redactError(err: unknown, apiKey: string): Error {
	const message = errorMessage(err);
	const redactedMessage = redactCredential(message, apiKey);
	if (redactedMessage === message && err instanceof Error) return err;
	const redactedError = new Error(redactedMessage);
	if (err instanceof Error) redactedError.name = err.name;
	return redactedError;
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (err) {
		// Only a parse failure is invalid JSON; a dropped connection or timeout keeps its own classification.
		if (!(err instanceof SyntaxError)) throw err;
		throw new Error(`Apify returned invalid JSON: ${errorMessage(err)}`);
	}
}

// Actor errors arrive as a flat { code, error }; platform errors (bad or missing token) nest as { error: { type, message } }.
function describeError(text: string): string {
	try {
		const body = JSON.parse(text) as Record<string, unknown>;
		if (typeof body.error === "string") return typeof body.code === "string" ? `${body.code}: ${body.error}` : body.error;
		const nested = body.error;
		if (nested && typeof nested === "object") {
			const { type, message } = nested as Record<string, unknown>;
			if (typeof message === "string") return typeof type === "string" ? `${type}: ${message}` : message;
		}
	} catch {
		// Not JSON: fall through to the raw text.
	}
	return text;
}

async function errorFromResponse(label: string, response: Response, apiKey: string): Promise<Error> {
	const errorText = await response.text();
	return new Error(`${label} error ${response.status}: ${redactCredential(describeError(errorText), apiKey).slice(0, 300)}`);
}

function parseSearchResponse(value: unknown): ApifySearchResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object");
	const results = (value as Record<string, unknown>).results;
	if (!Array.isArray(results)) throw invalidResponse("expected results array");
	return results as ApifySearchResult[];
}

export function isApifyAvailable(): boolean {
	return hasCredentialSource({ provider: "Apify", configuredValue: loadConfig().apifyApiKey, environmentValue: process.env.APIFY_TOKEN });
}

// Web Search returns one page of organic results in rank order: about 10 from Google (the default engine).
export async function searchWithApify(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const dateFrom = recencyDateFrom(options.recencyFilter);
	const body = {
		query: query.slice(0, MAX_QUERY_CHARS),
		maxResults: numResults,
		...(dateFrom ? { dateFrom } : {}),
		...(filters.include.length > 0 ? { allowedDomains: filters.include.slice(0, MAX_DOMAIN_FILTERS) } : {}),
		...(filters.exclude.length > 0 ? { blockedDomains: filters.exclude.slice(0, MAX_DOMAIN_FILTERS) } : {}),
	};
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: ApifySearchResult[];
	try {
		response = await fetchWithCredentialRedirects(resolveProviderApiUrl("apifySearch", APIFY_SEARCH_URL, loadConfig().apifySearchBaseUrl), {
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
		if (!response.ok) throw await errorFromResponse("Apify Web Search", response, apiKey);
		entries = parseSearchResponse(await readJson(response));
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`Apify Web Search request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: redactError(err, apiKey);
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
		// The API caps each domain list at 10 hostnames, so the full filter is reapplied here.
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

// Web Fetch reads one page and returns it as Markdown. It handles common bot protection and rate limits.
export async function extractWithApify(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
	const apiKey = await requireApiKey(signal);
	const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
		? Math.max(1, Math.floor(options.timeoutMs))
		: FETCH_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetchWithCredentialRedirects(resolveProviderApiUrl("apifyFetch", APIFY_FETCH_URL, loadConfig().apifyFetchBaseUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-web-access",
			},
			body: JSON.stringify({ url, formats: ["markdown"] }),
			signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) throw await errorFromResponse("Apify Web Fetch", response, apiKey);
		const value = await readJson(response);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object");
		const page = value as Record<string, unknown>;
		activityMonitor.logComplete(activityId, response.status);
		const content = typeof page.markdown === "string" ? page.markdown.trim() : "";
		if (!content) return null;
		const metadata = page.metadata && typeof page.metadata === "object" ? page.metadata as Record<string, unknown> : {};
		const fetchInfo = page.fetch && typeof page.fetch === "object" ? page.fetch as Record<string, unknown> : {};
		return {
			url,
			title: typeof metadata.title === "string" ? metadata.title.trim() : "",
			content,
			error: null,
			...(typeof fetchInfo.httpStatusCode === "number" ? { status: fetchInfo.httpStatusCode } : {}),
		};
	} catch (err) {
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw err;
		}
		const outgoing = timeoutSignal.aborted
			? new Error(`Apify Web Fetch request timed out after ${Math.round(timeoutMs / 1000)}s`)
			: redactError(err, apiKey);
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), apiKey));
		throw outgoing;
	}
}
