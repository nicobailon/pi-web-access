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

function tavilyKeyPool(): string[] {
	const keyBySlot = new Map<number, string>();
	for (const [name, value] of Object.entries(process.env)) {
		const match = name.match(/^TAVILY_API_KEY_(\d+)$/);
		if (!match || typeof value !== "string" || value.trim().length === 0) continue;
		const slot = Number(match[1]);
		if (!Number.isSafeInteger(slot) || slot < 1 || slot > TAVILY_KEY_POOL_MAX) continue;
		keyBySlot.set(slot, value.trim());
	}
	const entries = [...keyBySlot.entries()].sort(([a], [b]) => a - b);
	if (entries.length === 0) return [];
	const requestedSlot = Math.max(1, Number.parseInt(process.env.TAVILY_API_KEY_INDEX ?? "", 10) || 1);
	const start = Math.max(0, entries.findIndex(([slot]) => slot >= requestedSlot));
	return [...new Set([...entries.slice(start), ...entries.slice(0, start)].map(([, key]) => key))];
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
	}) || tavilyKeyPool().length > 0;
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

	const signal = requestSignal(options.signal);
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const pool = tavilyKeyPool();
		if (pool.length === 0) {
			return await tavilySearch(apiUrl, await requireApiKey(signal), body, numResults, options.includeContent === true, signal, activityId);
		}

		let lastError: Error | null = null;
		const tryKey = async (apiKey: string): Promise<SearchResponse | null> => {
			try {
				return await tavilySearch(apiUrl, apiKey, body, numResults, options.includeContent === true, signal, activityId);
			} catch (err) {
				if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
				if (!TAVILY_KEY_POOL_RETRIES.has(tavilyErrorStatus(err))) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));
				return null;
			}
		};
		for (const apiKey of pool) {
			const result = await tryKey(apiKey);
			if (result) return result;
		}

		const fallback = await getApiKey(signal);
		if (fallback && !pool.includes(fallback)) {
			const result = await tryKey(fallback);
			if (result) return result;
		}
		throw lastError ?? new Error("Tavily key pool exhausted");
	} catch (err) {
		if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) activityMonitor.logComplete(activityId, 0);
		else {
			const status = tavilyErrorStatus(err);
			if (status > 0) activityMonitor.logComplete(activityId, status);
			else activityMonitor.logError(activityId, errorMessage(err));
		}
		throw err;
	}
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
	includeContent: boolean,
	signal: AbortSignal,
	activityId: string,
): Promise<SearchResponse> {
	let response: Response;
	try {
		response = await fetchWithCredentialRedirects(apiUrl, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		}, ["Authorization"]);
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	if (!response.ok) {
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: TavilyResponse;
	try {
		data = await response.json() as TavilyResponse;
	} catch (err) {
		throw new Error(`Tavily API returned invalid JSON: ${errorMessage(err)}`);
	}

	activityMonitor.logComplete(activityId, response.status);
	const result: SearchResponse = {
		answer: typeof data.answer === "string" ? data.answer : "",
		results: mapResults(data.results, numResults),
	};
	if (includeContent) {
		const inlineContent = mapInlineContent(data.results);
		if (inlineContent.length > 0) result.inlineContent = inlineContent;
	}
	return result;
}
