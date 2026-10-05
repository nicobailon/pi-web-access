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
		// Fetch strips surrounding whitespace before sending; store the sent form so
		// redaction matches what an upstream error body can echo back.
		headers[name] = headerValue.trim();
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
		// Group the alternatives so the query terms apply to every site branch.
		parts.push(`(${filters.allowed.map(domain => `site:${domain}`).join(" OR ")})`);
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

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`degoog returned invalid response: ${message}`);
}

function parseResponse(value: unknown): DegoogResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected a results array");
	return envelope.results as DegoogResult[];
}

function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
	let redacted = text;
	for (const secret of secrets) redacted = redactCredential(redacted, secret);
	return redacted;
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
	const customHeaders = normalizeHeaders(loadConfig().degoogHeaders);
	const headers = mergeHeaders(customHeaders);
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	// Reverse-proxy header values can be credentials, so redact them alongside the API
	// key before an upstream error body can echo them back.
	const secrets = [apiKey, ...Object.values(customHeaders)];

	const body: Record<string, unknown> = { query: searchQuery, type: "web", page: 1 };
	if (options.recencyFilter) body.time = options.recencyFilter;
	if (engines.length > 0) body.engines = engines;

	const url = new URL(`${baseUrl}/api/search`);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: DegoogResult[];
	try {
		response = await fetchRemoteUrl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, {
			...loadSsrfConfig(),
			// Credentials and reverse-proxy headers must not follow a cross-origin redirect.
			onRedirect: ({ from, to, init }) => from.origin === to.origin
				? init
				: { ...init, headers: { Accept: "application/json", "Content-Type": "application/json" } },
		});

		if (!response.ok) {
			const errorText = redactSecrets(await response.text(), secrets).slice(0, 300);
			if (response.status === 401) {
				throw new Error(
					`degoog search error 401: this instance protects search routes. Set degoogApiKey in ${CONFIG_PATH} or DEGOOG_API_KEY. ${errorText.slice(0, 200)}`,
				);
			}
			throw new Error(`degoog search error ${response.status}: ${errorText}`);
		}

		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`degoog returned invalid JSON: ${errorMessage(err)}`);
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		// A caller cancellation is not a failure, but our own deadline is: distinguish
		// them so a timeout is not recorded as a completed request with status 0.
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`degoog request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: (() => {
				const redactedMessage = redactSecrets(message, secrets);
				if (redactedMessage === message && err instanceof Error) return err;
				const redactedError = new Error(redactedMessage);
				if (err instanceof Error) redactedError.name = err.name;
				return redactedError;
			})();
		activityMonitor.logError(activityId, redactSecrets(errorMessage(outgoing), secrets));
		throw outgoing;
	}

	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const item of entries) {
		if (!item || typeof item !== "object") continue;
		const rawUrl = resultText(item.url);
		if (!rawUrl) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(rawUrl);
		} catch {
			continue;
		}
		// Only absolute HTTP(S) links are usable as citations or fetch targets.
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (!matchesDomainFilters(resultUrl.href, filters)) continue;
		if (seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		results.push({
			title: resultText(item.title) || resultUrl.href,
			url: resultUrl.href,
			snippet: resultText(item.snippet) || resultText(item.content),
		});
		if (results.length >= numResults) break;
	}

	return { answer: formatSearchResultsAsAnswer(results), results };
}
