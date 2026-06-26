import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;

interface WebSearchConfig {
	searxngBaseUrl?: unknown;
}

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

interface SearXNGResult {
	title?: string;
	url?: string;
	content?: string;
	engine?: string;
	engines?: string[];
}

interface SearXNGResponse {
	results?: SearXNGResult[];
	answers?: string[];
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

function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function getBaseUrl(): string | null {
	return normalizeBaseUrl(process.env.SEARXNG_BASE_URL) ?? normalizeBaseUrl(loadConfig().searxngBaseUrl);
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"SearXNG base URL not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "searxngBaseUrl": "https://search.example.com" }\n` +
			"  2. Set SEARXNG_BASE_URL environment variable",
		);
	}
	return baseUrl;
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	if (!domainFilter?.length) return filters;

	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}

	return filters;
}

function buildSearXNGQuery(query: string, domainFilter: string[] | undefined): string {
	const filters = normalizeDomainFilters(domainFilter);
	const parts = [query];
	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map(domain => `site:${domain}`).join(" OR "));
	}
	for (const domain of filters.blocked) {
		parts.push(`-site:${domain}`);
	}
	return parts.join(" ");
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	let hostname = "";
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) return false;
	return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain));
}

function mapTimeRange(recencyFilter: SearchOptions["recencyFilter"]): string | null {
	if (recencyFilter === "day" || recencyFilter === "week" || recencyFilter === "month" || recencyFilter === "year") return recencyFilter;
	return null;
}

export function isSearXNGAvailable(): boolean {
	return !!getBaseUrl();
}

export async function searchWithSearXNG(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const baseUrl = requireBaseUrl();
	const numResults = normalizeCount(options.numResults);
	const domainFilters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildSearXNGQuery(query, options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });

	const url = new URL(`${baseUrl}/search`);
	url.searchParams.set("q", searchQuery);
	url.searchParams.set("format", "json");
	const timeRange = mapTimeRange(options.recencyFilter);
	if (timeRange) url.searchParams.set("time_range", timeRange);

	try {
		const response = await fetch(url.toString(), {
			method: "GET",
			headers: { "Accept": "application/json" },
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`SearXNG search error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let data: SearXNGResponse;
		try {
			data = await response.json() as SearXNGResponse;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`SearXNG returned invalid JSON: ${message}`);
		}

		activityMonitor.logComplete(activityId, response.status);
		const results: SearchResult[] = [];
		for (const item of data.results ?? []) {
			if (!item.url || !matchesDomainFilters(item.url, domainFilters)) continue;
			results.push({
				title: item.title || item.url,
				url: item.url,
				snippet: item.content || "",
			});
			if (results.length >= numResults) break;
		}

		const answerParts: string[] = [];
		for (const answer of data.answers ?? []) {
			if (typeof answer === "string" && answer.trim()) answerParts.push(answer.trim());
		}
		answerParts.push(...results.map((result) => {
			if (result.snippet) return `${result.snippet}\nSource: ${result.title} (${result.url})`;
			return `Source: ${result.title} (${result.url})`;
		}));

		return { answer: answerParts.join("\n\n"), results };
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
