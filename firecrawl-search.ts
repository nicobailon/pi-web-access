import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import { getFirecrawlConfig, isFirecrawlAvailable } from "./firecrawl-config.js";
import { isBrowserStealthAvailable } from "./browser-config.js";
import { extractViaBrowserStealth } from "./browser-stealth.js";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.js";
import { hasExaApiKey, isExaAvailable, searchWithExa } from "./exa.js";

export type SearchProvider = "auto" | "perplexity" | "firecrawl" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

let cachedSearchConfig: { searchProvider: SearchProvider; searchModel?: string } | null = null;

function getSearchConfig(): { searchProvider: SearchProvider; searchModel?: string } {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto", searchModel: undefined };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: {
		searchProvider?: SearchProvider;
		provider?: SearchProvider;
		searchModel?: unknown;
	};
	try {
		raw = JSON.parse(rawText) as {
			searchProvider?: SearchProvider;
			provider?: SearchProvider;
			searchModel?: unknown;
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	cachedSearchConfig = {
		searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider),
		searchModel: normalizeSearchModel(raw.searchModel),
	};
	return cachedSearchConfig;
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "perplexity" || normalized === "firecrawl" || normalized === "exa"
		? normalized
		: "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

// Firecrawl search implementation
interface FirecrawlSearchResponse {
	success: boolean;
	data?: {
		links?: Array<{ url: string; title?: string; description?: string }>;
		markdown?: string;
	};
	error?: string;
}

async function searchWithFirecrawl(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse | null> {
	const config = getFirecrawlConfig();
	if (!config) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const body: Record<string, unknown> = {
			query,
			limit: options.numResults ?? 10,
		};

		if (options.recencyFilter) {
			const timeMap: Record<string, string> = {
				day: "1d",
				week: "7d",
				month: "30d",
				year: "365d",
			};
			if (timeMap[options.recencyFilter]) {
				body.tbs = timeMap[options.recencyFilter];
			}
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
		const signal = options.signal
			? AbortSignal.any([options.signal, controller.signal])
			: controller.signal;

		const res = await fetch(`${config.baseUrl}/v1/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal,
		});

		clearTimeout(timeoutId);

		if (!res.ok) {
			const errorText = await res.text();
			activityMonitor.logComplete(activityId, res.status);
			throw new Error(`Firecrawl search error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = (await res.json()) as FirecrawlSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		if (!data.success || !data.data) {
			return {
				answer: data.error ?? "Firecrawl returned no results",
				results: [],
			};
		}

		const answer = data.data.markdown?.trim() ?? "";
		const results: SearchResult[] = [];
		const seen = new Set<string>();

		if (data.data.links?.length) {
			for (const link of data.data.links) {
				if (seen.has(link.url)) continue;
				seen.add(link.url);

				if (options.domainFilter?.length) {
					const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
					if (excludes.some(domain => link.url.includes(domain))) continue;
				}

				results.push({
					title: link.title ?? new URL(link.url).hostname,
					url: link.url,
					snippet: link.description ?? "",
				});
			}
		}

		return { answer, results };
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

// Browser stealth search (for Gemini Web fallback)
async function searchWithBrowserStealth(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse | null> {
	const url = `https://gemini.google.com/app?q=${encodeURIComponent(query)}`;

	try {
		const result = await extractViaBrowserStealth(url, options.signal, { timeoutMs: 120000 });
		if (!result || result.content.length < 100) return null;

		// Extract URLs from markdown links
		const results: SearchResult[] = [];
		const seen = new Set<string>();
		const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
		for (const match of result.content.matchAll(linkRegex)) {
			const linkUrl = match[2];
			if (seen.has(linkUrl)) continue;
			seen.add(linkUrl);
			results.push({ title: match[1], url: linkUrl, snippet: "" });
		}

		return { answer: result.content, results };
	} catch {
		return null;
	}
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider ?? config.searchProvider;

	if (provider === "perplexity") {
		const result = await searchWithPerplexity(query, options);
		return { ...result, provider: "perplexity" };
	}

	if (provider === "firecrawl") {
		const result = await searchWithFirecrawl(query, options);
		if (result) return { ...result, provider: "firecrawl" };
		throw new Error(
			"Firecrawl search unavailable. Set FIRECRAWL_API_KEY in ~/.pi/web-search.json"
		);
	}

	if (provider === "exa") {
		const exaApiKeyConfigured = hasExaApiKey();
		try {
			const result = await searchWithExa(query, options);
			if (result && "exhausted" in result) {
				throw new Error(
					"Exa monthly free tier exhausted (1,000 requests). Resets next month.\n" +
					"  Use provider: 'perplexity' or 'firecrawl', or upgrade at exa.ai/pricing"
				);
			}
			if (result && "answer" in result) return { ...result, provider: "exa" };
			if (exaApiKeyConfigured) {
				throw new Error("Exa search returned no results.");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.toLowerCase().includes("abort")) throw err;
			if (exaApiKeyConfigured) throw err;
		}
	}

	const fallbackErrors: string[] = [];

	if (provider !== "exa" && isExaAvailable()) {
		try {
			const result = await searchWithExa(query, options);
			if (result && "answer" in result) return { ...result, provider: "exa" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	if (isPerplexityAvailable()) {
		try {
			const result = await searchWithPerplexity(query, options);
			return { ...result, provider: "perplexity" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Perplexity: ${errorMessage(err)}`);
		}
	}

	if (isFirecrawlAvailable()) {
		try {
			const result = await searchWithFirecrawl(query, options);
			if (result) return { ...result, provider: "firecrawl" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Firecrawl: ${errorMessage(err)}`);
		}
	}

	if (isBrowserStealthAvailable()) {
		try {
			const result = await searchWithBrowserStealth(query, options);
			if (result) return { ...result, provider: "firecrawl" as ResolvedSearchProvider };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Browser stealth: ${errorMessage(err)}`);
		}
	}

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
		"  1. Set perplexityApiKey in ~/.pi/web-search.json\n" +
		"  2. Set EXA_API_KEY (or exaApiKey) in ~/.pi/web-search.json\n" +
		"  3. Set FIRECRAWL_API_KEY in ~/.pi/web-search.json\n" +
		"  4. Enable browserStealthEnabled in ~/.pi/web-search.json"
	);
}
