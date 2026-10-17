import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
// The API rejects queries over 128 Unicode characters, operators included.
const MAX_QUERY_CHARS = 128;
// `summary` is documented as 600-800 characters and written for models; keep it whole.
const MAX_SNIPPET_CHARS = 800;
const RECENCY_DAYS: Record<NonNullable<SearchOptions["recencyFilter"]>, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

interface WebSearchConfig {
	deepseekApiKey?: unknown;
}

interface DeepSeekResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	summary?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await resolveCredential({
		provider: "DeepSeek",
		configuredValue: loadConfig().deepseekApiKey,
		environmentValue: process.env.DEEPSEEK_API_KEY,
		signal,
	});
	if (!apiKey) {
		throw new Error(
			"DeepSeek API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "deepseekApiKey": "your-key" }\n` +
			"  2. Set DEEPSEEK_API_KEY environment variable\n" +
			"Get a key at https://platform.deepseek.com/api_keys",
		);
	}
	return apiKey;
}

// DeepSeek documents `site:` joined with OR, `-site:`, and `after:<date>` as query operators.
function buildQuery(query: string, options: SearchOptions): string {
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of options.domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude : include;
		if (!target.includes(domain)) target.push(domain);
	}
	const parts = [query.trim()];
	if (include.length > 0) parts.push(include.map(domain => `site:${domain}`).join(" OR "));
	for (const domain of exclude) parts.push(`-site:${domain}`);
	if (options.recencyFilter) {
		const after = new Date(Date.now() - RECENCY_DAYS[options.recencyFilter] * 86_400_000).toISOString().slice(0, 10);
		parts.push(`after:${after}`);
	}
	const built = parts.join(" ");
	const length = [...built].length;
	if (length > MAX_QUERY_CHARS) {
		throw new Error(`DeepSeek invalid request: the query is ${length} characters with domain and date filters; DeepSeek accepts at most ${MAX_QUERY_CHARS}`);
	}
	return built;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function parseResponse(value: unknown): DeepSeekResult[] {
	const results = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).results : undefined;
	if (!Array.isArray(results)) throw new Error("DeepSeek returned invalid response: expected a results array");
	return results as DeepSeekResult[];
}

// Errors use the OpenAI shape `{ error: { message, type, param, code } }`.
function describeError(body: string): string {
	try {
		const error = (JSON.parse(body) as { error?: { message?: unknown } }).error;
		const message = text(error?.message);
		if (message) return message;
	} catch {}
	return body;
}

export function isDeepSeekAvailable(): boolean {
	return hasCredentialSource({ provider: "DeepSeek", configuredValue: loadConfig().deepseekApiKey, environmentValue: process.env.DEEPSEEK_API_KEY });
}

export async function searchWithDeepSeek(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const builtQuery = buildQuery(query, options);
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: DeepSeekResult[];
	try {
		response = await fetchWithCredentialRedirects(DEEPSEEK_SEARCH_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query: builtQuery, count: numResults }),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = redactCredential(describeError(await response.text()), apiKey).slice(0, 300);
			throw new Error(`DeepSeek error ${response.status}: ${errorText}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`DeepSeek returned invalid JSON: ${errorMessage(err)}`);
		}
		entries = parseResponse(rawData);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`DeepSeek request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
			: (() => {
				const redactedMessage = redactCredential(message, apiKey);
				if (redactedMessage === message && err instanceof Error) return err;
				const redactedError = new Error(redactedMessage);
				if (err instanceof Error) redactedError.name = err.name;
				return redactedError;
			})();
		activityMonitor.logError(activityId, redactCredential(errorMessage(outgoing), apiKey));
		throw outgoing;
	}
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.url !== "string" || !entry.url) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(entry.url);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		results.push({
			title: text(entry.title) || `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: (text(entry.summary) || text(entry.snippet)).slice(0, MAX_SNIPPET_CHARS),
		});
		if (results.length >= numResults) break;
	}
	// A non-empty page with no usable entry is a broken response, not "no results", so routing can fall back.
	if (entries.length > 0 && results.length === 0) throw new Error("DeepSeek returned invalid response: no result had an http(s) URL");
	return { answer: formatSearchResultsAsAnswer(results), results };
}
