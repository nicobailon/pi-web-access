import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

const LINKUP_SEARCH_URL = "https://api.linkup.so/v1/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;
const DEPTHS = ["flash", "fast", "standard", "deep"] as const;
type LinkupDepth = typeof DEPTHS[number];

interface LinkupConfig {
	linkupBaseUrl?: unknown;
	linkupApiKey?: unknown;
	linkupDepth?: unknown;
}

interface LinkupResult {
	type?: unknown;
	name?: unknown;
	url?: unknown;
	content?: unknown;
}

let cachedConfig: LinkupConfig | undefined;

function loadConfig(): LinkupConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) return cachedConfig = {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	} catch {
		// JSON parse errors can quote credentials from the config file.
		throw new Error(`Failed to parse ${CONFIG_PATH}: expected valid JSON`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	return cachedConfig = parsed as LinkupConfig;
}

function getDepth(): LinkupDepth {
	const value = loadConfig().linkupDepth;
	if (value === undefined) return "fast";
	if (typeof value !== "string" || !DEPTHS.includes(value as LinkupDepth)) {
		throw new Error(`linkupDepth in ${CONFIG_PATH} must be one of: ${DEPTHS.join(", ")}`);
	}
	return value as LinkupDepth;
}

function domainFilters(values: string[] | undefined): { include: string[]; exclude: string[] } {
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of values ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude : include;
		if (!target.includes(domain)) target.push(domain);
	}
	if (include.length > 100 || exclude.length > 100) {
		throw new Error("Linkup domainFilter must contain at most 100 included and 100 excluded domains");
	}
	return { include, exclude };
}

function recencyToDate(filter: SearchOptions["recencyFilter"]): string | undefined {
	if (!filter) return undefined;
	const days = { day: 1, week: 7, month: 30, year: 365 }[filter];
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function parseResponse(value: unknown): LinkupResult[] {
	if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).results)) {
		throw new Error("Linkup returned invalid response: expected results array");
	}
	return (value as { results: LinkupResult[] }).results;
}

export function isLinkupAvailable(): boolean {
	return hasCredentialSource({ provider: "Linkup", configuredValue: loadConfig().linkupApiKey, environmentValue: process.env.LINKUP_API_KEY });
}

export async function searchWithLinkup(query: string, options: SearchOptions & { includeContent?: boolean } = {}): Promise<SearchResponse> {
	const depth = getDepth();
	const filters = domainFilters(options.domainFilter);
	const apiKey = await resolveCredential({
		provider: "Linkup",
		configuredValue: loadConfig().linkupApiKey,
		environmentValue: process.env.LINKUP_API_KEY,
		signal: options.signal,
	});
	if (!apiKey) {
		throw new Error(`Linkup API key not found. Set linkupApiKey in ${CONFIG_PATH} or LINKUP_API_KEY. Get a key at https://app.linkup.so`);
	}
	const numResults = normalizeSearchResultCount(options.numResults);
	const fromDate = recencyToDate(options.recencyFilter);
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
	const activityId = activityMonitor.logStart({ type: "api", query });
	let entries: LinkupResult[];
	try {
		const response = await fetchWithCredentialRedirects(resolveProviderApiUrl("linkup", LINKUP_SEARCH_URL, loadConfig().linkupBaseUrl), {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				q: query, depth, outputType: "searchResults", maxResults: numResults,
				...(fromDate ? { fromDate } : {}),
				...(filters.include.length ? { includeDomains: filters.include } : {}),
				...(filters.exclude.length ? { excludeDomains: filters.exclude } : {}),
			}),
			signal,
		}, ["Authorization"]);
		if (!response.ok) {
			const body = redactCredential(await response.text(), apiKey).slice(0, 300);
			throw new Error(`Linkup error ${response.status}: ${body}`);
		}
		let data: unknown;
		try {
			data = await response.json();
		} catch (err) {
			// Preserve transport and cancellation errors for routing. Syntax errors
			// can quote response content, so do not echo their messages.
			if (!(err instanceof SyntaxError)) throw err;
			throw new Error("Linkup returned invalid JSON");
		}
		entries = parseResponse(data);
		activityMonitor.logComplete(activityId, response.status);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = timeout.aborted || (err instanceof Error && err.name === "TimeoutError")
			? "Linkup request timed out after 60s"
			: redactCredential(err instanceof Error ? err.message : String(err), apiKey);
		activityMonitor.logError(activityId, message);
		const outgoing = err instanceof TypeError ? new TypeError(message) : new Error(message);
		if (err instanceof Error && !timeout.aborted) outgoing.name = err.name;
		throw outgoing;
	}
	const results: SearchResponse["results"] = [];
	const inlineContent: ExtractedContent[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || entry.type !== "text" || typeof entry.url !== "string") continue;
		let url: URL;
		try { url = new URL(entry.url); } catch { continue; }
		if (url.protocol !== "http:" && url.protocol !== "https:") continue;
		const matches = (domain: string) => url.hostname === domain || url.hostname.endsWith(`.${domain}`);
		if (filters.exclude.some(matches) || (filters.include.length && !filters.include.some(matches))) continue;
		if (seen.has(url.href)) continue;
		seen.add(url.href);
		const title = text(entry.name) || `Source ${results.length + 1}`;
		const content = typeof entry.content === "string" ? entry.content.trim().slice(0, 4_000) : "";
		results.push({ title, url: url.href, snippet: text(content).slice(0, 500) });
		if (options.includeContent && content) inlineContent.push({ url: url.href, title, content, error: null });
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results, ...(inlineContent.length ? { inlineContent } : {}) };
}
