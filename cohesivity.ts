import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { getWebSearchConfigPath } from "./utils.ts";

// The path segment is fixed by the service.
export const COHESIVITY_SEARCH_URL = "https://cohesivity.ai/edge/exa-api/search";
const CLIENT_USER_AGENT = "pi-web-access";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const HIGHLIGHT_SENTENCES = 2;
const MAX_SNIPPET_CHARS = 500;
const RECENCY_DAYS: Record<NonNullable<SearchOptions["recencyFilter"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

interface WebSearchConfig {
	cohesivityApplicationKey?: unknown;
}

interface CohesivityResult {
	title?: unknown;
	url?: unknown;
	highlights?: unknown;
	summary?: unknown;
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

async function requireApplicationKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveCredential({
		provider: "Cohesivity",
		configuredValue: loadConfig().cohesivityApplicationKey,
		environmentValue: process.env.COHESIVITY_APPLICATION_KEY,
		signal,
	});
	if (!key) {
		throw new Error(
			"Cohesivity application key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "cohesivityApplicationKey": "your-coh_application_key" }\n` +
			"  2. Set COHESIVITY_APPLICATION_KEY environment variable\n" +
			"Run `npx @cohesivity/init` to create a .cohesivity file and use its coh_application_key",
		);
	}
	return key;
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

function startPublishedDate(recency: NonNullable<SearchOptions["recencyFilter"]>): string {
	return new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString();
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function highlightText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return text(value.filter((item): item is string => typeof item === "string").join(" "));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`Cohesivity search returned invalid response: ${message}`);
}

function parseResponse(value: unknown): CohesivityResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	if (!Array.isArray(envelope.results)) throw invalidResponse("expected results array");
	return envelope.results as CohesivityResult[];
}

// Errors are `{ error: { code, message: "[Cohesivity] ..." } }`; keep only the readable message.
function describeError(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown } };
		const message = text(parsed?.error?.message).replace(/^\[Cohesivity\]\s*/i, "");
		if (message) return message;
	} catch {}
	return text(body);
}

function errorHint(status: number, message: string): string {
	if (status === 401) return " (check that cohesivityApplicationKey or COHESIVITY_APPLICATION_KEY is the coh_application_key from your .cohesivity file)";
	if (status === 403 && /not provisioned/i.test(message)) return " (search must be provisioned once for this Cohesivity project; ask your coding agent to provision it with the management key in .cohesivity)";
	if (status === 429) return " (rate limited; anonymous projects allow 5 search requests per minute and 50 in total until claimed)";
	return "";
}

// The key can only travel as the `key` query parameter, and fetchWithCredentialRedirects
// strips credential headers, not URL parameters. The endpoint never redirects, so every
// redirect is refused rather than followed, which keeps the key off any other URL.
async function fetchWithoutRedirects(url: URL, init: RequestInit): Promise<Response> {
	const response = await fetch(url, { ...init, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`Cohesivity search error ${response.status}: refused an unexpected redirect`);
	}
	return response;
}

export function isCohesivityAvailable(): boolean {
	return hasCredentialSource({ provider: "Cohesivity", configuredValue: loadConfig().cohesivityApplicationKey, environmentValue: process.env.COHESIVITY_APPLICATION_KEY });
}

export async function searchWithCohesivity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const key = await requireApplicationKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const body = {
		query,
		numResults,
		type: "auto",
		contents: { highlights: { numSentences: HIGHLIGHT_SENTENCES } },
		...(filters.include.length > 0 ? { includeDomains: filters.include } : {}),
		...(filters.exclude.length > 0 ? { excludeDomains: filters.exclude } : {}),
		...(options.recencyFilter ? { startPublishedDate: startPublishedDate(options.recencyFilter) } : {}),
	};
	const url = new URL(COHESIVITY_SEARCH_URL);
	url.searchParams.set("key", key);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: CohesivityResult[];
	try {
		response = await fetchWithoutRedirects(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				// The service's firewall may reject the default Node fetch User-Agent.
				"User-Agent": CLIENT_USER_AGENT,
			},
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		});
		if (!response.ok) {
			const message = redactCredential(describeError(await response.text()), key).slice(0, 300);
			throw new Error(`Cohesivity search error ${response.status}: ${message}${errorHint(response.status, message)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`Cohesivity search returned invalid JSON: ${errorMessage(err)}`);
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		// Always rethrow a fresh error: the original may carry the request URL, and with it
		// the key, in its message or cause chain.
		const outgoing = new Error(providerTimeout
			? `Cohesivity search request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`
			: redactCredential(errorMessage(err), key));
		if (!providerTimeout && err instanceof Error) outgoing.name = err.name;
		activityMonitor.logError(activityId, outgoing.message);
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
		// Domains are filtered natively; this is a backstop.
		if (!passesDomainFilters(resultUrl, filters)) continue;
		if (seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		const snippet = highlightText(entry.highlights) || text(entry.summary) || text(entry.text);
		results.push({
			title: text(entry.title) || `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: snippet.slice(0, MAX_SNIPPET_CHARS),
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
