/**
 * SearXNG Search Integration
 * Privacy-respecting metasearch engine
 */

export interface SearchOptions {
	numResults?: number;
	engine?: string;
	categories?: string[];
}

export interface SearchResultItem {
	url: string;
	title: string;
	snippet: string;
	engine?: string;
}

export interface SearchResponse {
	results: SearchResultItem[];
}

const SEARXNG_BASE_URL = "http://localhost:8081";

/**
 * Search using SearXNG
 */
export async function searchWithSearXNG(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const numResults = options.numResults ?? 10;
	const engines = options.engine || "google,bing,duckduckgo";
	const categories = options.categories || ["general"];

	const url = new URL("/search", SEARXNG_BASE_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("engines", engines);
	url.searchParams.set("categories", categories.join(","));
	url.searchParams.set("pageno", "1");
	url.searchParams.set("number_of_results", String(numResults));

	try {
		const response = await fetch(url.toString());
		if (!response.ok) {
			throw new Error(`SearXNG search failed: ${response.status}`);
		}

		const data = await response.json();
		const results: SearchResultItem[] = (data.results || []).map((r: any) => ({
			url: r.url || "",
			title: r.title || "",
			snippet: r.content || "",
			engine: r.engine || "",
		}));

		return { results };
	} catch (error) {
		console.error(`SearXNG search error: ${error}`);
		return { results: [] };
	}
}

/**
 * Check if SearXNG is available
 */
export function isSearXNGAvailable(): boolean {
	return typeof fetch !== "undefined";
}
