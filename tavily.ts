import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface WebSearchConfig {
	tavilyApiKey?: unknown;
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

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function getApiKey(): string | null {
	return normalizeApiKey(process.env.TAVILY_API_KEY) ?? normalizeApiKey(loadConfig().tavilyApiKey);
}

export function isTavilyAvailable(): boolean {
	return !!getApiKey();
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(60000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function mapRecencyFilter(filter: string): string | undefined {
	const mapping: Record<string, string> = {
		day: "day",
		week: "week",
		month: "month",
		year: "year",
	};
	return mapping[filter];
}

function mapDomainFilter(domainFilter: string[] | undefined): { include_domains?: string[]; exclude_domains?: string[] } {
	if (!domainFilter?.length) return {};
	const include_domains = domainFilter
		.filter(d => !d.startsWith("-") && d.trim().length > 0)
		.map(d => d.trim());
	const exclude_domains = domainFilter
		.filter(d => d.startsWith("-"))
		.map(d => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(include_domains.length ? { include_domains } : {}),
		...(exclude_domains.length ? { exclude_domains } : {}),
	};
}

interface TavilySearchResponse {
	answer?: string;
	results?: Array<{
		title?: string;
		url?: string;
		content?: string;
		score?: number;
	}>;
}

export async function searchWithTavily(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = getApiKey();
	if (!apiKey) {
		throw new Error(
			"Tavily API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "tavilyApiKey": "your-key" }\n` +
			"  2. Set TAVILY_API_KEY environment variable\n" +
			"Get a key at https://app.tavily.com"
		);
	}

	const activityId = activityMonitor.logStart({ type: "api", query });

	const numResults = Math.min(options.numResults ?? 5, 20);
	const domainFilters = mapDomainFilter(options.domainFilter);
	const timeRange = options.recencyFilter ? mapRecencyFilter(options.recencyFilter) : undefined;

	const requestBody: Record<string, unknown> = {
		query,
		max_results: numResults,
		search_depth: "advanced",
		include_answer: "advanced",
		...domainFilters,
		...(timeRange ? { time_range: timeRange } : {}),
	};

	let response: Response;
	try {
		response = await fetch(TAVILY_SEARCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify(requestBody),
			signal: requestSignal(options.signal),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = await response.text();
		throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: TavilySearchResponse;
	try {
		data = await response.json() as TavilySearchResponse;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Tavily API returned invalid JSON: ${message}`);
	}

	const answer = data.answer || "";
	const results: SearchResult[] = [];
	if (Array.isArray(data.results)) {
		for (let i = 0; i < data.results.length; i++) {
			const item = data.results[i];
			if (!item?.url) continue;
			results.push({
				title: item.title || `Source ${i + 1}`,
				url: item.url,
				snippet: item.content || "",
			});
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer, results };
}
