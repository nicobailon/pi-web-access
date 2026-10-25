import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl } from "./ssrf-protection.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
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
	deepseekBaseUrl?: unknown;
	deepseekApiKey?: unknown;
}

interface DeepSeekResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	summary?: unknown;
	content?: unknown;
}

interface DeepSeekSearchOptions extends SearchOptions {
	includeContent?: boolean;
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

// DeepSeek Fetch escapes Markdown punctuation even when the content is already Markdown.
// Keep escapes that could change emphasis, code spans and links; unescape only the safe subset.
function unescapeMarkdownSegment(segment: string): string {
	return segment.replace(/\\([/.,:()&+#>|!_\-"'])/g, (match, char: string, offset: number, whole: string) => {
		if (char === "!" && whole[offset + 2] === "[") return match;
		return char;
	});
}

function normalizeInlineMarkdown(line: string): string {
	return line
		.split(/(`+[^`]*`+)/g)
		.map((part, index) => (index % 2 === 0 ? unescapeMarkdownSegment(part) : part))
		.join("");
}

function normalizeDeepSeekMarkdown(markdown: string): string {
	let fence: { char: string; length: number } | null = null;
	return markdown
		.split("\n")
		.map((line) => {
			const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
			if (match) {
				const marker = match[1]!;
				if (fence === null) {
					fence = { char: marker[0]!, length: marker.length };
				} else if (
					marker[0] === fence.char &&
					marker.length >= fence.length &&
					line.slice(match[0].length).trim() === ""
				) {
					fence = null;
				}
				return line;
			}
			return fence === null ? normalizeInlineMarkdown(line) : line;
		})
		.join("\n");
}

const ERROR_TITLE = /^(?:404\b|page not found\b|not found\b)/i;

function firstMarkdownHeading(content: string): string {
	let fence: { char: string; length: number } | null = null;
	for (const line of content.split("\n")) {
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (fence === null) {
				fence = { char: marker[0]!, length: marker.length };
			} else if (
				marker[0] === fence.char &&
				marker.length >= fence.length &&
				line.slice(fenceMatch[0].length).trim() === ""
			) {
				fence = null;
			}
			continue;
		}
		if (fence !== null) continue;
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
		if (heading) return heading[1]!.trim();
	}
	return "";
}

// A site-level 404 can still return 200 + a short navigation shell. Do not reject
// short pages generally: some valid pages are shorter than MIN_USEFUL_CONTENT.
// A title alone is not enough: "404 Not Found - HTTP" can be a real article.
function isUnusableDeepSeekPage(title: string, content: string): boolean {
	// Long pages are real content even if their title or first heading happens to be an error term.
	if (content.length >= 500) return false;
	const heading = firstMarkdownHeading(content);
	if (heading !== "" && ERROR_TITLE.test(heading)) return true;
	return ERROR_TITLE.test(text(title)) && /\b(?:404|page not found|not found)\b/i.test(content.slice(0, 200));
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

export async function searchWithDeepSeek(query: string, options: DeepSeekSearchOptions = {}): Promise<SearchResponse> {
	const builtQuery = buildQuery(query, options);
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let entries: DeepSeekResult[];
	try {
		response = await fetchWithCredentialRedirects(resolveProviderApiUrl("deepseek", DEEPSEEK_SEARCH_URL, loadConfig().deepseekBaseUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query: builtQuery, count: numResults, ...(options.includeContent ? { need_content: true } : {}) }),
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
	const inlineContent: ExtractedContent[] = [];
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
		const title = text(entry.title) || `Source ${results.length + 1}`;
		results.push({
			title,
			url: resultUrl.href,
			snippet: (text(entry.summary) || text(entry.snippet)).slice(0, MAX_SNIPPET_CHARS),
		});
		if (options.includeContent) {
			// Search content is not pre-escaped (unlike Fetch), so its backslashes are real text.
			const content = typeof entry.content === "string" ? entry.content.trim() : "";
			if (content) inlineContent.push({ url: resultUrl.href, title, content, error: null });
		}
		if (results.length >= numResults) break;
	}
	// A non-empty page with no usable entry is a broken response, not "no results", so routing can fall back.
	if (entries.length > 0 && results.length === 0) throw new Error("DeepSeek returned invalid response: no result had an http(s) URL");
	const searchResponse: SearchResponse = { answer: formatSearchResultsAsAnswer(results), results };
	if (inlineContent.length > 0) searchResponse.inlineContent = inlineContent;
	return searchResponse;
}

/**
 * Fetch a single page through DeepSeek's Fetch API, which returns page content
 * already converted to Markdown. Opt-in via `fetchRouting.providers`.
 */
export async function extractWithDeepSeek(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
	const apiKey = await requireApiKey(signal);
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	try {
		const ssrf = loadSsrfConfig();
		await validateRemoteUrl(url, {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			domainPolicy: loadFetchContentDomainPolicy(),
			...(options.lookup ? { lookup: options.lookup } : {}),
		});
		const response = await fetchWithCredentialRedirects(resolveProviderApiUrl("deepseek", DEEPSEEK_FETCH_URL, loadConfig().deepseekBaseUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ url }),
			signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = redactCredential(describeError(await response.text()), apiKey).slice(0, 300);
			throw new Error(`DeepSeek Fetch error ${response.status}: ${errorText}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			if (err instanceof Error && err.name === "TimeoutError") throw err;
			throw new Error(`DeepSeek Fetch returned invalid JSON: ${errorMessage(err)}`);
		}
		if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
			throw new Error("DeepSeek Fetch returned an unexpected response shape");
		}
		const page = rawData as { title?: unknown; content?: unknown };
		const title = typeof page.title === "string" ? page.title.trim() : "";
		const content = typeof page.content === "string" ? normalizeDeepSeekMarkdown(page.content).trim() : "";
		if (!content || isUnusableDeepSeekPage(title, content)) {
			activityMonitor.logComplete(activityId, response.status);
			return null;
		}
		activityMonitor.logComplete(activityId, response.status);
		return {
			url,
			title,
			content,
			error: null,
		};
	} catch (err) {
		const message = errorMessage(err);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		activityMonitor.logError(activityId, redactCredential(message, apiKey));
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new Error(`DeepSeek Fetch request timed out after ${Math.round(timeoutMs / 1000)}s`);
		}
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}
