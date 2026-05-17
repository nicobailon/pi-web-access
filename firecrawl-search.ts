import { activityMonitor } from "./activity.js";
import { getFirecrawlConfig } from "./firecrawl-config.js";
import type { SearchResponse, SearchResult, SearchOptions } from "./perplexity.js";

export type SearchProvider = "auto" | "perplexity" | "firecrawl" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

const CONFIG_PATH = "/home/john/.pi/web-search.json";

let cachedSearchConfig: { searchProvider: SearchProvider; searchModel?: string } | null = null;

function getSearchConfig(): { searchProvider: SearchProvider; searchModel?: string } {
	if (cachedSearchConfig) return cachedSearchConfig;
	cachedSearchConfig = { searchProvider: "auto", searchModel: undefined };
	return cachedSearchConfig;
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

function buildFirecrawlQuery(query: string, options: SearchOptions): string {
	let q = query;
	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: " past 24 hours",
			week: " past week",
			month: " past month",
			year: " past year",
		};
		q += labels[options.recencyFilter] ?? "";
	}
	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (excludes.length) {
			q += " -site:" + excludes.join(" -site:");
		}
		if (includes.length) {
			// Firecrawl doesn't support site: in query param, filter results later
		}
	}
	return q;
}

async function searchWithFirecrawl(
	query: string,
	options: SearchOptions,
): Promise<SearchResponse | null> {
	const config = getFirecrawlConfig();
	if (!config) return null;

	const firecrawlQuery = buildFirecrawlQuery(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const res = await fetch(`${config.baseUrl}/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				query: firecrawlQuery,
				limit: 10,
				includeDomains: options.domainFilter?.filter(d => !d.startsWith("-")),
			}),
			signal: AbortSignal.any([
				AbortSignal.timeout(60000),
				...(options.signal ? [options.signal] : []),
			]),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Firecrawl search error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as FirecrawlSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const results = (data.data || [])
			.filter((item: FirecrawlSearchItem) => item.url)
			.map((item: FirecrawlSearchItem) => ({
				title: item.title || new URL(item.url).hostname,
				url: item.url,
				snippet: item.description || "",
			}));

		return { results };
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

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider ?? config.searchProvider;

	if (provider === "perplexity") {
		const { searchWithPerplexity } = await import("./perplexity.js");
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
		const { hasExaApiKey, isExaAvailable, searchWithExa } = await import("./exa.js");
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

	if (provider !== "exa") {
		const { hasExaApiKey, isExaAvailable, searchWithExa } = await import("./exa.js");
		if (isExaAvailable()) {
			try {
				const result = await searchWithExa(query, options);
				if (result && "answer" in result) return { ...result, provider: "exa" };
			} catch (err) {
				if (isAbortError(err)) throw err;
				fallbackErrors.push(`Exa: ${errorMessage(err)}`);
			}
		}
	}

	const { isPerplexityAvailable, searchWithPerplexity } = await import("./perplexity.js");
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

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
		"  1. Set perplexityApiKey in ~/.pi/web-search.json\n" +
		"  2. Set EXA_API_KEY (or exaApiKey) in ~/.pi/web-search.json\n" +
		"  3. Set FIRECRAWL_API_KEY in ~/.pi/web-search.json"
	);
}

interface FirecrawlSearchResponse {
	data?: FirecrawlSearchItem[];
	error?: string;
}

interface FirecrawlSearchItem {
	title?: string;
	url: string;
	description?: string;
}
