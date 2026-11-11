import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

// Autom SERP API: https://docs.autom.dev
const AUTOM_GOOGLE_URL = "https://api.autom.dev/v1/google/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const RECENCY_TBS: Record<NonNullable<SearchOptions["recencyFilter"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

interface WebSearchConfig {
	automApiKey?: unknown;
	automBaseUrl?: unknown;
}

interface AutomResult {
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
		provider: "Autom",
		configuredValue: loadConfig().automApiKey,
		environmentValue: process.env.AUTOM_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Autom API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "automApiKey": "your-key" }\n` +
			"  2. Set AUTOM_API_KEY environment variable\n" +
			"Get a key at https://app.autom.dev",
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

function passesDomainFilters(url: string, filters: DomainFilters): boolean {
	if (filters.include.length === 0 && filters.exclude.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
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
	return new Error(`Autom API returned invalid response: ${message}`);
}

function parseResponse(value: unknown): AutomResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	// A query with no match comes back without the array.
	if (envelope.organic_results === undefined) return [];
	if (!Array.isArray(envelope.organic_results)) throw invalidResponse("expected organic_results array");
	return envelope.organic_results as AutomResult[];
}

export function isAutomAvailable(): boolean {
	return hasCredentialSource({ provider: "Autom", configuredValue: loadConfig().automApiKey, environmentValue: process.env.AUTOM_API_KEY });
}

export async function searchWithAutom(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiUrl = new URL(resolveProviderApiUrl("autom", AUTOM_GOOGLE_URL, loadConfig().automBaseUrl));
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	apiUrl.searchParams.set("query", buildQuery(query, filters));
	if (options.recencyFilter) apiUrl.searchParams.set("tbs", RECENCY_TBS[options.recencyFilter]);
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetchWithCredentialRedirects(apiUrl.toString(), {
			method: "GET",
			headers: { "x-api-key": apiKey, Accept: "application/json" },
			signal: options.signal ? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		}, ["x-api-key"]);
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Autom API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		// Only a parse failure is invalid JSON; a dropped connection or a cancel keeps its own meaning,
		// so searchRouting can still fall back on network errors.
		if (!(err instanceof SyntaxError)) throw err;
		throw new Error(`Autom API returned invalid JSON: ${redactCredential(errorMessage(err), apiKey)}`);
	}
	let entries: AutomResult[];
	try {
		entries = parseResponse(rawData);
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw err;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.link !== "string" || !/^https?:\/\//i.test(entry.link)) continue;
		if (!passesDomainFilters(entry.link, filters)) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: entry.link,
			snippet: typeof entry.snippet === "string" ? entry.snippet : "",
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
