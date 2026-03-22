import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";

export type { SearchResult, SearchResponse, SearchOptions } from "./perplexity.js";
import type { SearchResult, SearchResponse, SearchOptions } from "./perplexity.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface WebSearchConfig {
	tavilyApiKey?: string;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;

	if (existsSync(CONFIG_PATH)) {
		try {
			const content = readFileSync(CONFIG_PATH, "utf-8");
			cachedConfig = JSON.parse(content) as WebSearchConfig;
			return cachedConfig;
		} catch {
			cachedConfig = {};
		}
	} else {
		cachedConfig = {};
	}
	return cachedConfig;
}

function getApiKey(): string | undefined {
	const config = loadConfig();
	return process.env.TAVILY_API_KEY || config.tavilyApiKey || undefined;
}

export function isTavilyAvailable(): boolean {
	return Boolean(getApiKey());
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

	try {
		const { tavily } = await import("@tavily/core");
		const client = tavily({ apiKey });

		const numResults = Math.min(options.numResults ?? 5, 20);

		const searchOptions: Record<string, unknown> = {
			maxResults: numResults,
			includeAnswer: "advanced",
			searchDepth: "advanced",
		};

		if (options.recencyFilter) {
			searchOptions.timeRange = options.recencyFilter;
		}

		if (options.domainFilter?.length) {
			const includes = options.domainFilter.filter(d => !d.startsWith("-"));
			const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
			if (includes.length) searchOptions.includeDomains = includes;
			if (excludes.length) searchOptions.excludeDomains = excludes;
		}

		const response = await client.search(query, searchOptions);

		const answer = response.answer ?? "";
		const results: SearchResult[] = (response.results ?? []).map((r: { title?: string; url: string; content?: string }) => ({
			title: r.title || "",
			url: r.url,
			snippet: r.content || "",
		}));

		activityMonitor.logComplete(activityId, 200);
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}
