import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

// SpecStream Search API (GET /v1/web-search, $5 per 1,000 searches) and Extract API
// (POST /v1/extract, $0.80 per 1,000 pages): https://specstream.ai/search-api and https://specstream.ai/extract-api
const SPECSTREAM_SEARCH_URL = "https://api.specstream.ai/v1/web-search";
const SPECSTREAM_EXTRACT_URL = "https://api.specstream.ai/v1/extract";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 60_000;
const MAX_QUERY_CHARS = 2_000;

interface WebSearchConfig {
	specstreamBaseUrl?: unknown;
	specstreamApiKey?: unknown;
}

interface SpecStreamSource {
	url?: unknown;
	title?: unknown;
	snippet?: unknown;
}

interface SpecStreamExtractResult {
	url?: unknown;
	status?: unknown;
	title?: unknown;
	text?: unknown;
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
		provider: "SpecStream",
		configuredValue: loadConfig().specstreamApiKey,
		environmentValue: process.env.SPECSTREAM_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"SpecStream API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "specstreamApiKey": "your-key" }\n` +
			"  2. Set SPECSTREAM_API_KEY environment variable\n" +
			"Get a key at https://specstream.ai",
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
	return new Error(`SpecStream returned invalid response: ${message}`);
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
		throw new Error(`SpecStream returned invalid JSON: ${errorMessage(err)}`);
	}
}

// The API wraps every reply as { data, error }. A body without the wrapper is read as it is.
function unwrapEnvelope(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	const data = envelope.data;
	if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
	const error = envelope.error;
	if (data === null && error && typeof error === "object") {
		const message = (error as Record<string, unknown>).message;
		throw new Error(`SpecStream error: ${typeof message === "string" && message ? message : "request failed"}`);
	}
	return envelope;
}

function parseSearchResponse(value: unknown): SpecStreamSource[] {
	const data = unwrapEnvelope(value);
	if (!Array.isArray(data.sources)) throw invalidResponse("expected sources array");
	return data.sources as SpecStreamSource[];
}

function parseExtractResponse(value: unknown): SpecStreamExtractResult[] {
	const data = unwrapEnvelope(value);
	if (!Array.isArray(data.results)) throw invalidResponse("expected results array");
	return data.results as SpecStreamExtractResult[];
}

export function isSpecStreamAvailable(): boolean {
	return hasCredentialSource({ provider: "SpecStream", configuredValue: loadConfig().specstreamApiKey, environmentValue: process.env.SPECSTREAM_API_KEY });
}

// The search reply lists the pages it read in rank order.
export async function searchWithSpecStream(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const endpoint = new URL(resolveProviderApiUrl("specstream", SPECSTREAM_SEARCH_URL, loadConfig().specstreamBaseUrl));
	endpoint.searchParams.set("q", query.slice(0, MAX_QUERY_CHARS));
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: SpecStreamSource[];
	try {
		response = await fetchWithCredentialRedirects(endpoint.toString(), {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": "pi-web-access",
			},
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SpecStream error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		entries = parseSearchResponse(await readJson(response));
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`SpecStream request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
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

// Extract reads a page live and returns its main text as markdown. A page with no text is not charged.
export async function extractWithSpecStream(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
	const apiKey = await requireApiKey(signal);
	const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
		? Math.max(1, Math.floor(options.timeoutMs))
		: EXTRACT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetchWithCredentialRedirects(resolveProviderApiUrl("specstream", SPECSTREAM_EXTRACT_URL, loadConfig().specstreamBaseUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-web-access",
			},
			body: JSON.stringify({ urls: [url], format: "markdown" }),
			signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SpecStream Extract error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		const [result] = parseExtractResponse(await readJson(response));
		if (!result || typeof result !== "object") throw invalidResponse("expected one result for the URL");
		activityMonitor.logComplete(activityId, response.status);
		if (result.status !== "ok") {
			if (result.status === "failed" || result.status === "blocked") {
				throw new Error(`SpecStream Extract could not read the page: ${String(result.status)}`);
			}
			return null;
		}
		const content = typeof result.text === "string" ? result.text.trim() : "";
		if (!content) return null;
		return { url, title: typeof result.title === "string" ? result.title.trim() : "", content, error: null };
	} catch (err) {
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw err;
		}
		const outgoing = timeoutSignal.aborted
			? new Error(`SpecStream Extract request timed out after ${Math.round(timeoutMs / 1000)}s`)
			: redactError(err, apiKey);
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), apiKey));
		throw outgoing;
	}
}
