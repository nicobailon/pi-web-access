import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import type { ExtractedContent } from "./extract.js";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface WebSearchConfig {
	braveApiKey?: unknown;
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
	return normalizeApiKey(process.env.BRAVE_API_KEY) ?? normalizeApiKey(loadConfig().braveApiKey);
}

/** Returns true if a Brave API key is configured. */
export function isBraveAvailable(): boolean {
	return !!getApiKey();
}

export async function searchWithBrave(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const apiKey = getApiKey();
	if (!apiKey) {
		throw new Error(
			"Brave Search API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "braveApiKey": "your-key" }\n` +
			"  2. Set BRAVE_API_KEY environment variable\n" +
			"Get a key at https://brave.com/search/api/",
		);
	}

	const activityId = activityMonitor.logStart({ type: "api", query });

	const numResults = Math.min(options.numResults ?? 5, 20);
	const params = new URLSearchParams({ q: query, count: String(numResults) });

	if (options.recencyFilter) {
		const freshnessMap: Record<string, string> = {
			day: "pd",
			week: "pw",
			month: "pm",
			year: "py",
		};
		const tf = freshnessMap[options.recencyFilter];
		if (tf) params.set("freshness", tf);
	}

	try {
		const response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
			method: "GET",
			headers: {
				"X-Subscription-Token": apiKey,
				"Accept": "application/json",
				"Accept-Encoding": "gzip",
			},
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(30000), options.signal])
				: AbortSignal.timeout(30000),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`Brave Search API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = (await response.json()) as {
			web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
		};
		activityMonitor.logComplete(activityId, response.status);

		const webResults = data.web?.results ?? [];
		const results: SearchResult[] = [];
		const inlineContent: ExtractedContent[] = [];

		for (const item of webResults.slice(0, numResults)) {
			if (!item.url) continue;
			results.push({
				title: item.title || item.url,
				url: item.url,
				snippet: item.description || "",
			});
			if (item.description && options.includeContent) {
				inlineContent.push({
					url: item.url,
					title: item.title || item.url,
					content: item.description,
					error: null,
				});
			}
		}

		// Build an answer from snippets
		const answer = results
			.map((r) => {
				if (r.snippet) return `${r.snippet}\nSource: ${r.title} (${r.url})`;
				return `Source: ${r.title} (${r.url})`;
			})
			.join("\n\n");

		const responseObj: SearchResponse = { answer, results };
		if (inlineContent.length > 0) responseObj.inlineContent = inlineContent;
		return responseObj;
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