import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { applyDomainFilter } from "./domain-filter-normalization.ts";
import { getWebSearchConfigPath, resolveProviderApiUrl, fetchWithCredentialRedirects, isRecord } from "./utils.ts";

const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** "generated" when the snippet is text from the provider's own answer around a citation, not text from the page. */
	snippetSource?: "generated";
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	model?: string;
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

interface WebSearchConfig {
	perplexityBaseUrl?: unknown;
	perplexityApiKey?: unknown;
	perplexitySearchMode?: unknown;
	perplexityChatModel?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const content = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(content) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveCredential({
		provider: "Perplexity",
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
		signal,
	});
	if (!key) {
		throw new Error(
			"Perplexity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api"
		);
	}
	return key;
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
		const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

function validateDomainFilter(domains: string[]): string[] {
	return domains.filter((d) => {
		const domain = d.startsWith("-") ? d.slice(1) : d;
		return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
	});
}

export function isPerplexityAvailable(): boolean {
	return hasCredentialSource({
		provider: "Perplexity",
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
	});
}

interface PerplexityRequestOptions {
	activityQuery: string;
	signal?: AbortSignal;
}

async function postPerplexity(
	url: string,
	body: Record<string, unknown>,
	options: PerplexityRequestOptions,
): Promise<Record<string, unknown>> {
	const apiUrl = resolveProviderApiUrl("perplexity", url, loadConfig().perplexityBaseUrl);
	checkRateLimit();

	const activityId = activityMonitor.logStart({ type: "api", query: options.activityQuery });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	const apiKey = await getApiKey(options.signal);

	// Reported as a timeout, not an abort: a raw TimeoutError reads as cancellation and would end the search.
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const timedOut = () => timeout.aborted && !options.signal?.aborted;
	const timeoutError = () => new Error("Perplexity API error 408: request timed out");

	let response: Response;
	try {
		response = await fetchWithCredentialRedirects(apiUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		}, ["Authorization"]);
	} catch (err) {
		if (timedOut()) {
			activityMonitor.logError(activityId, "request timed out");
			throw timeoutError();
		}
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	activityMonitor.logComplete(activityId, response.status);

	if (!response.ok) {
		let errorText: string;
		try {
			errorText = redactCredential(await response.text(), apiKey);
		} catch (err) {
			if (timedOut()) throw timeoutError();
			throw err;
		}
		throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
	}

	try {
		return await response.json();
	} catch (err) {
		if (timedOut()) throw timeoutError();
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Perplexity API returned invalid JSON: ${message}`);
	}
}

function getSearchMode(): "search" | "chat" {
	const mode = loadConfig().perplexitySearchMode;
	if (mode === undefined) return "search";
	if (mode !== "search" && mode !== "chat") {
		throw new Error("perplexitySearchMode must be \"search\" or \"chat\"");
	}
	return mode;
}

function getChatModel(): string {
	const model = loadConfig().perplexityChatModel;
	if (model === undefined) return "sonar";
	if (typeof model !== "string" || !model.trim()) {
		throw new Error("perplexityChatModel must be a non-empty string");
	}
	return model.trim();
}

function citationUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function parseChatSearch(data: unknown, numResults: number, domainFilter?: string[]): SearchResponse {
	const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
	const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
	if (!isRecord(data) || !message || typeof message.content !== "string") {
		throw new Error("Perplexity Chat API returned an invalid response: expected choices[0].message.content to be a string");
	}

	// Native Sonar returns citations (URLs) and search_results (metadata). Some
	// OpenAI-compatible gateways preserve citations inside message.extensions.
	const metadata = new Map<string, string>();
	const searchResults = Array.isArray(data.search_results) ? data.search_results : [];
	for (const entry of searchResults) {
		if (!isRecord(entry)) continue;
		const url = citationUrl(entry.url);
		if (url && typeof entry.title === "string" && entry.title.trim()) metadata.set(url, entry.title.trim());
	}
	const sources = new Map<string, SearchResult>();
	const addCitation = (entry: unknown) => {
		const record = isRecord(entry) ? entry : undefined;
		const url = citationUrl(record ? record.url : entry);
		if (!url) return;
		const title = record && typeof record.title === "string" ? record.title.trim() : "";
		if (!sources.has(url)) sources.set(url, { title: title || metadata.get(url) || url, url, snippet: "" });
	};
	if (Array.isArray(data.citations)) data.citations.forEach(addCitation);
	const extensions = isRecord(message.extensions) ? message.extensions : undefined;
	if (Array.isArray(extensions?.citations)) extensions.citations.forEach(addCitation);
	for (const entry of searchResults) addCitation(entry);

	const results = applyDomainFilter([...sources.values()], domainFilter).slice(0, numResults);
	// Match the Search API's source-list output, not Sonar's generated prose.
	// Citation metadata is not page text: source_check must fetch its own evidence.
	return { answer: formatSearchResultsAsAnswer(results), results };
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const numResults = typeof options.numResults === "number" && Number.isFinite(options.numResults)
		? Math.max(1, Math.min(Math.floor(options.numResults), 20))
		: 5;

	const chat = getSearchMode() === "chat";
	const requestBody: Record<string, unknown> = chat ? {
		model: getChatModel(),
		messages: [{ role: "user", content: query }],
		stream: false,
		max_tokens: 1024,
	} : {
		query,
		max_results: numResults,
		search_type: "fast",
		search_context_size: "medium",
	};

	if (options.recencyFilter) {
		requestBody.search_recency_filter = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const validated = validateDomainFilter(options.domainFilter);
		if (validated.length > 0) {
			requestBody.search_domain_filter = validated;
		}
	}

	const data = await postPerplexity(chat ? PERPLEXITY_CHAT_URL : PERPLEXITY_SEARCH_URL, requestBody, { activityQuery: query, signal: options.signal });
	if (chat) return parseChatSearch(data, numResults, options.domainFilter);

	const results: SearchResult[] = [];
	for (const entry of Array.isArray(data.results) ? data.results : []) {
		if (!entry || typeof entry !== "object" || typeof entry.url !== "string" || !entry.url) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: entry.url,
			snippet: typeof entry.snippet === "string" ? entry.snippet.trim() : "",
		});
		if (results.length >= numResults) break;
	}

	return { answer: formatSearchResultsAsAnswer(results), results };
}

/** Asks Sonar for a prose answer. The Search API returns only ranked pages, so prompts that need prose use this. */
export async function askPerplexity(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string> {
	const data = await postPerplexity(PERPLEXITY_CHAT_URL, {
		model: "sonar",
		messages: [{ role: "user", content: prompt }],
		max_tokens: 1024,
		return_related_questions: false,
	}, { activityQuery: prompt, signal: options.signal });

	const content = (data.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
	return typeof content === "string" ? content : "";
}
