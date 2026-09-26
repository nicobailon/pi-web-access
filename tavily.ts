import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveApiBaseUrl } from "./utils.ts";

const TAVILY_API_BASE_URL = "https://api.tavily.com";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	tavilyApiKey?: unknown;
	tavilyBaseUrl?: unknown;
}

interface TavilyResult {
	title?: string;
	url?: string;
	content?: string;
	raw_content?: string | null;
}

interface TavilyResponse {
	answer?: string;
	results?: TavilyResult[];
}

interface TavilySearchOptions extends SearchOptions {
	includeContent?: boolean;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Tavily",
		configuredValue: loadConfig().tavilyApiKey,
		environmentValue: process.env.TAVILY_API_KEY,
		signal,
	});
}

const TAVILY_KEY_POOL_MAX = 20;
const TAVILY_KEY_POOL_RETRIES = new Set([401, 402, 403, 429, 432]);

function tavilyKeyPool(): { keys: string[]; effective: string | null } {
	const keys: string[] = [];
	const keyBySlot = new Map<number, string>();
	for (let slot = 1; slot <= TAVILY_KEY_POOL_MAX; slot += 1) {
		const value = process.env[`TAVILY_API_KEY_${slot}`];
		if (typeof value === "string" && value.trim().length > 0) {
			const key = value.trim();
			keys.push(key);
			keyBySlot.set(slot, key);
		}
	}
	if (keys.length === 0) return { keys, effective: null };
	if (typeof process.env.TAVILY_API_KEY === "string" && process.env.TAVILY_API_KEY.trim().length > 0) {
		const solo = process.env.TAVILY_API_KEY.trim();
		if (!keys.includes(solo)) keys.push(solo);
	}
	const fallback = Math.max(1, Number.parseInt(process.env.TAVILY_API_KEY_INDEX ?? "", 10) || 1);
	return { keys, effective: keyBySlot.get(((fallback - 1) % TAVILY_KEY_POOL_MAX) + 1) ?? keys[0] };
}

function getApiUrl(): string {
	return `${resolveApiBaseUrl({
		configKey: "tavilyBaseUrl",
		configuredValue: loadConfig().tavilyBaseUrl,
		defaultValue: TAVILY_API_BASE_URL,
		environmentKey: "TAVILY_BASE_URL",
		environmentValue: process.env.TAVILY_BASE_URL,
	})}/search`;
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"Tavily API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "tavilyApiKey": "your-key" }\n` +
			"  2. Set TAVILY_API_KEY environment variable\n" +
			"Get a key at https://app.tavily.com/",
		);
	}
	return apiKey;
}

function mapDomainFilter(domainFilter: string[] | undefined): { include_domains?: string[]; exclude_domains?: string[] } {
	if (!domainFilter?.length) return {};
	const include_domains: string[] = [];
	const exclude_domains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude_domains : include_domains;
		if (!target.includes(domain)) target.push(domain);
	}
	return {
		...(include_domains.length > 0 ? { include_domains } : {}),
		...(exclude_domains.length > 0 ? { exclude_domains } : {}),
	};
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function mapResults(results: TavilyResult[] | undefined, numResults: number): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (const item of results) {
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "",
		});
		if (mapped.length >= numResults) break;
	}
	return mapped;
}

function mapInlineContent(results: TavilyResult[] | undefined): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (!item?.url || typeof item.raw_content !== "string" || item.raw_content.trim().length === 0) return [];
		return [{
			url: item.url,
			title: item.title || "",
			content: item.raw_content,
			error: null,
		}];
	});
}

export function isTavilyAvailable(): boolean {
	return hasCredentialSource({
		provider: "Tavily",
		configuredValue: loadConfig().tavilyApiKey,
		environmentValue: process.env.TAVILY_API_KEY,
	}) || tavilyKeyPool().effective !== null;
}

export async function searchWithTavily(query: string, options: TavilySearchOptions = {}): Promise<SearchResponse> {
	const apiUrl = getApiUrl();
	const numResults = normalizeSearchResultCount(options.numResults);
	const body: Record<string, unknown> = {
		query,
		search_depth: "basic",
		max_results: numResults,
		include_answer: "basic",
		include_raw_content: options.includeContent ? "markdown" : false,
		...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
		...mapDomainFilter(options.domainFilter),
	};

	const pool = tavilyKeyPool();
	if (pool.effective !== null) {
		// Pool mode: try keys in order, starting at the configured slot.
		const start = Math.max(0, pool.keys.indexOf(pool.effective));
		const ordered = [...pool.keys.slice(start), ...pool.keys.slice(0, start)];
		let lastError: Error | null = null;
		for (const apiKey of ordered) {
			try {
				return await tavilySearch(apiUrl, apiKey, body, numResults, options);
			} catch (err) {
				if (isAbortError(err)) throw err;
				const status = tavilyErrorStatus(err);
				if (!TAVILY_KEY_POOL_RETRIES.has(status)) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));
			}
		}
		throw lastError ?? new Error("Tavily key pool exhausted");
	}
	return tavilySearch(apiUrl, await requireApiKey(options.signal), body, numResults, options);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function tavilyErrorStatus(err: unknown): number {
	const status = (err as { status?: unknown }).status;
	if (typeof status === "number") return status;
	const match = errorMessage(err).match(/\bTavily API error (\d{3})\b/);
	return match ? Number(match[1]) : 0;
}

async function tavilySearch(
	apiUrl: string,
	apiKey: string,
	body: Record<string, unknown>,
	numResults: number,
	options: TavilySearchOptions,
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query: typeof body.query === "string" ? body.query : "" });
	let response: Response;
	try {
		response = await fetchWithCredentialRedirects(apiUrl, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal),
		}, ["Authorization"]);
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
		throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: TavilyResponse;
	try {
		data = await response.json() as TavilyResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Tavily API returned invalid JSON: ${errorMessage(err)}`);
	}

	activityMonitor.logComplete(activityId, response.status);
	const result: SearchResponse = {
		answer: typeof data.answer === "string" ? data.answer : "",
		results: mapResults(data.results, numResults),
	};
	if (options.includeContent) {
		const inlineContent = mapInlineContent(data.results);
		if (inlineContent.length > 0) result.inlineContent = inlineContent;
	}
	return result;
}
