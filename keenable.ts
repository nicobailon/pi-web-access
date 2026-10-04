import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";

const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
// Without a key the request goes to the public endpoint, which identifies the caller
// by X-Keenable-Title instead of a credential and answers 400 when the header is missing.
const KEENABLE_PUBLIC_SEARCH_URL = "https://api.keenable.ai/v1/search/public";
const KEENABLE_CLIENT_TITLE = "pi-web-access";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_REQUEST_RESULTS = 50;
const MAX_SNIPPET_CHARS = 500;
const RECENCY_DAYS: Record<NonNullable<SearchOptions["recencyFilter"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

interface WebSearchConfig {
	keenableApiKey?: unknown;
}

interface KeenableResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
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
		provider: "Keenable",
		configuredValue: loadConfig().keenableApiKey,
		environmentValue: process.env.KEENABLE_API_KEY,
		signal,
	});
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

// One domain uses the API's `site` field; the query syntax covers the rest, so no ranked
// window has to be filtered down locally to find in-domain pages.
function buildQuery(query: string, filters: DomainFilters, site: string | undefined): string {
	const parts = [query];
	if (!site && filters.include.length > 1) parts.push(`(${filters.include.map(domain => `site:${domain}`).join(" OR ")})`);
	for (const domain of filters.exclude) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function publishedAfter(recency: NonNullable<SearchOptions["recencyFilter"]>): string {
	return new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Keenable returned invalid response: ${message}`);
}

function parseResponse(value: unknown): KeenableResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	return envelope.results as KeenableResult[];
}

// The public endpoint needs no key, so the provider is always usable once selected.
export function isKeenableAvailable(): boolean {
	return true;
}

export async function searchWithKeenable(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await getApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const site = filters.include.length === 1 ? filters.include[0] : undefined;
	// Results are reapplied to the domain filters locally, so leave a little headroom.
	const hasDomainClauses = filters.include.length > 1 || filters.exclude.length > 0;
	const body = {
		query: buildQuery(query, filters, site),
		max_results: hasDomainClauses ? Math.min(MAX_REQUEST_RESULTS, numResults + 5) : numResults,
		snippet_max_length: MAX_SNIPPET_CHARS,
		...(site ? { site } : {}),
		...(options.recencyFilter ? { published_after: publishedAfter(options.recencyFilter) } : {}),
	};
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
		"X-Keenable-Title": KEENABLE_CLIENT_TITLE,
		...(apiKey ? { "X-API-Key": apiKey } : {}),
	};
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: KeenableResult[];
	try {
		response = await fetchWithCredentialRedirects(apiKey ? KEENABLE_SEARCH_URL : KEENABLE_PUBLIC_SEARCH_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["X-API-Key"]);
		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey).slice(0, 300);
			const hint = response.status === 429 && !apiKey
				? ` (keyless rate limit; set keenableApiKey or KEENABLE_API_KEY to raise it)`
				: "";
			throw new Error(`Keenable error ${response.status}: ${errorText}${hint}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`Keenable returned invalid JSON: ${errorMessage(err)}`);
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
			? new Error(`Keenable request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
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
		// The page text lives in `snippet`; `description` is usually empty and only a fallback.
		const snippet = text(entry.snippet) || text(entry.description);
		results.push({
			title: text(entry.title) || `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: snippet.slice(0, MAX_SNIPPET_CHARS),
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
