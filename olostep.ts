import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const OLOSTEP_ANSWERS_URL = "https://api.olostep.com/v1/answers";
const OLOSTEP_SCRAPES_URL = "https://api.olostep.com/v1/scrapes";
const CONFIG_PATH = getWebSearchConfigPath();

interface WebSearchConfig {
	olostepApiKey?: unknown;
}

interface OlostepAnswerResult {
	url: string;
	title: string;
	description?: string;
}

interface OlostepAnswerResponse {
	answer?: string;
	results?: OlostepAnswerResult[];
}

interface OlostepScrapeResponse {
	markdown_content?: string;
	page_title?: string;
	url?: string;
	error?: string;
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
	return normalizeApiKey(process.env.OLOSTEP_API_KEY) ?? normalizeApiKey(loadConfig().olostepApiKey);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(30000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function mapResults(results: OlostepAnswerResult[] | undefined): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		mapped.push({
			title: item.title || `Source ${i + 1}`,
			url: item.url,
			snippet: item.description || "",
		});
	}
	return mapped;
}

export function isOlostepAvailable(): boolean {
	return !!getApiKey();
}

export async function searchWithOlostep(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const body: Record<string, unknown> = { query };
		if (options.numResults && options.numResults !== 5) {
			body.numResults = options.numResults;
		}
		if (options.recencyFilter) {
			const filterMap: Record<string, string> = {
				day: "day",
				week: "week",
				month: "month",
				year: "year",
			};
			const mapped = filterMap[options.recencyFilter];
			if (mapped) body.recencyFilter = mapped;
		}
		if (options.domainFilter?.length) {
			const include = options.domainFilter
				.filter(d => !d.startsWith("-") && d.trim().length > 0)
				.map(d => d.trim());
			const exclude = options.domainFilter
				.filter(d => d.startsWith("-"))
				.map(d => d.slice(1).trim())
				.filter(Boolean);
			if (include.length) body.domainFilter = include;
			if (exclude.length) body.excludeDomains = exclude;
		}

		const response = await fetch(OLOSTEP_ANSWERS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Olostep API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json() as OlostepAnswerResponse;
		activityMonitor.logComplete(activityId, response.status);

		return {
			answer: data.answer || "",
			results: mapResults(data.results),
		};
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

export async function extractWithOlostep(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `olostep-scrape: ${url}` });

	try {
		const response = await fetch(OLOSTEP_SCRAPES_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url,
				formats: ["markdown"],
			}),
			signal: requestSignal(signal),
		});

		if (!response.ok) {
			const errorText = await response.text();
			activityMonitor.logError(activityId, `Olostep scrape error ${response.status}: ${errorText.slice(0, 200)}`);
			return null;
		}

		const data = await response.json() as OlostepScrapeResponse;
		activityMonitor.logComplete(activityId, response.status);

		const content = data.markdown_content?.trim() || "";
		if (!content) return null;

		return {
			url: data.url || url,
			title: data.page_title || "",
			content,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
