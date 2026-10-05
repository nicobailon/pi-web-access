import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import { fetchRemoteUrl, loadSsrfConfig } from "./ssrf-protection.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();
// degoog is a self-hosted metasearch front end. The public instance keeps the
// provider usable without configuration; DEGOOG_URL or degoogBaseUrl point it at
// a private deployment, which is what SSRF-guarded internal hosts require.
const DEFAULT_BASE_URL = "https://degoog.org";
const SEARCH_TIMEOUT_MS = 30_000;

interface WebSearchConfig {
	degoogBaseUrl?: unknown;
	degoogApiKey?: unknown;
	degoogEngines?: unknown;
	degoogHeaders?: unknown;
}

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

interface DegoogResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	content?: unknown;
}

interface DegoogResponse {
	results?: DegoogResult[];
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

function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function getBaseUrl(): string | null {
	// An explicitly set variable wins, including an empty one that disables the
	// provider, so a configured base never silently falls back to the public instance.
	if (process.env.DEGOOG_URL !== undefined) return normalizeBaseUrl(process.env.DEGOOG_URL);
	const configured = loadConfig().degoogBaseUrl;
	if (configured !== undefined) return normalizeBaseUrl(configured);
	return DEFAULT_BASE_URL;
}

function normalizeEngines(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const engines: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const engine = entry.trim();
		if (engine && !engines.includes(engine)) engines.push(engine);
	}
	return engines;
}

function isValidHeaderValue(value: string): boolean {
	try {
		new Headers({ "x-pi-web-access-validation": value });
		return true;
	} catch {
		return false;
	}
}

function normalizeHeaders(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const headers: Record<string, string> = {};
	for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
		if (typeof headerValue !== "string") continue;
		const name = key.trim();
		// RFC 7230 token chars only — reject empty or malformed header names.
		if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
		if (!isValidHeaderValue(headerValue)) continue;
		headers[name] = headerValue;
	}
	return headers;
}

function mergeHeaders(extra: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
	for (const [name, value] of Object.entries(extra)) {
		for (const existing of Object.keys(headers)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
		}
		headers[name] = value;
	}
	return headers;
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"degoog base URL is invalid or missing. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "degoogBaseUrl": "https://degoog.example.com" }\n` +
			"  2. Set DEGOOG_URL to an HTTP(S) URL\n" +
			"  3. Remove the override to use the public instance at https://degoog.org",
		);
	}
	return baseUrl;
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function buildQuery(query: string, filters: NormalizedDomainFilters): string {
	const parts = [query];
	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map(domain => `site:${domain}`).join(" OR "));
	}
	for (const domain of filters.blocked) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) return false;
	return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain));
}

function resultText(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function isDegoogAvailable(): boolean {
	return getBaseUrl() !== null;
}

export async function searchWithDegoog(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const baseUrl = requireBaseUrl();
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildQuery(query, filters);
	const engines = normalizeEngines(loadConfig().degoogEngines);
	const apiKey = await resolveCredential({
		provider: "degoog",
		configuredValue: loadConfig().degoogApiKey,
		environmentValue: process.env.DEGOOG_API_KEY,
		signal: options.signal,
	});
	const headers = mergeHeaders(normalizeHeaders(loadConfig().degoogHeaders));
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const body: Record<string, unknown> = { query: searchQuery, type: "web", page: 1 };
	if (options.recencyFilter) body.time = options.recencyFilter;
	if (engines.length > 0) body.engines = engines;

	const url = new URL(`${baseUrl}/api/search`);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });

	try {
		const response = await fetchRemoteUrl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		}, {
			...loadSsrfConfig(),
			// Credentials and reverse-proxy headers must not follow a cross-origin redirect.
			onRedirect: ({ from, to, init }) => from.origin === to.origin
				? init
				: { ...init, headers: { Accept: "application/json", "Content-Type": "application/json" } },
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redactCredential(await response.text(), apiKey);
			if (response.status === 401) {
				throw new Error(
					`degoog search error 401: this instance protects search routes. Set degoogApiKey in ${CONFIG_PATH} or DEGOOG_API_KEY. ${errorText.slice(0, 200)}`,
				);
			}
			throw new Error(`degoog search error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let data: DegoogResponse;
		try {
			data = await response.json() as DegoogResponse;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`degoog returned invalid JSON: ${message}`);
		}

		activityMonitor.logComplete(activityId, response.status);
		const results: SearchResult[] = [];
		for (const item of Array.isArray(data.results) ? data.results : []) {
			const resultUrl = resultText(item?.url);
			if (!resultUrl || !matchesDomainFilters(resultUrl, filters)) continue;
			results.push({
				title: resultText(item?.title) || resultUrl,
				url: resultUrl,
				snippet: resultText(item?.snippet) || resultText(item?.content),
			});
			if (results.length >= numResults) break;
		}

		return { answer: formatSearchResultsAsAnswer(results), results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw err;
	}
}
