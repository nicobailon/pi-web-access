import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { getWebSearchConfigPath, resolveProviderApiUrl, fetchWithCredentialRedirects } from "./utils.ts";

const TABSTACK_RESEARCH_URL = "https://api.tabstack.ai/v1/research";
const TABSTACK_EXTRACT_URL = "https://api.tabstack.ai/v1/extract/markdown";
const CONFIG_PATH = getWebSearchConfigPath();
const RESEARCH_MODES = ["fast", "balanced"] as const;
type TabstackResearchMode = typeof RESEARCH_MODES[number];
// Fast research usually answers in seconds; balanced runs several iterations and can take minutes.
const RESEARCH_TIMEOUT_MS: Record<TabstackResearchMode, number> = { fast: 120_000, balanced: 300_000 };
const EXTRACT_TIMEOUT_MS = 90_000;

interface WebSearchConfig {
	tabstackBaseUrl?: unknown;
	tabstackApiKey?: unknown;
	tabstackResearchMode?: unknown;
}

interface TabstackCitedPage {
	id?: string;
	url?: string;
	title?: string | null;
	summary?: string | null;
	claims?: string[];
}

interface TabstackResearchComplete {
	report?: string;
	metadata?: { citedPages?: TabstackCitedPage[] };
}

interface TabstackResearchError {
	message?: string;
	error?: { message?: string; name?: string };
}

interface TabstackExtractResponse {
	url?: string;
	content?: string;
	metadata?: { title?: string | null } | null;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

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
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveCredential({
		provider: "Tabstack",
		configuredValue: loadConfig().tabstackApiKey,
		environmentValue: process.env.TABSTACK_API_KEY,
		signal,
	});
	if (!key) {
		throw new Error(
			"Tabstack API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "tabstackApiKey": "your-key" }\n` +
			"  2. Set TABSTACK_API_KEY environment variable\n" +
			"Get a key at https://console.tabstack.ai",
		);
	}
	return key;
}

export function isTabstackAvailable(): boolean {
	return hasCredentialSource({
		provider: "Tabstack",
		configuredValue: loadConfig().tabstackApiKey,
		environmentValue: process.env.TABSTACK_API_KEY,
	});
}

function getResearchMode(): TabstackResearchMode {
	const value = loadConfig().tabstackResearchMode;
	if (value === undefined) return "fast";
	if (typeof value !== "string" || !RESEARCH_MODES.includes(value as TabstackResearchMode)) {
		throw new Error(`tabstackResearchMode in ${CONFIG_PATH} must be one of: ${RESEARCH_MODES.join(", ")}`);
	}
	return value as TabstackResearchMode;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function tabstackRequest(
	label: "Research" | "Extract",
	url: string,
	apiKey: string,
	body: Record<string, unknown>,
	accept: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const response = await fetchWithCredentialRedirects(resolveProviderApiUrl("tabstack", url, loadConfig().tabstackBaseUrl), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: accept,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(signal, timeoutMs),
		}, ["Authorization"]);
		// Research streams until the report is written, so the deadline also covers the body read.
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(`Tabstack ${label} API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`);
		}
		return raw;
	} catch (err) {
		const message = errorMessage(err);
		const isRequestAbort = err instanceof Error
			? err.name === "AbortError" || err.name === "TimeoutError" || /abort|timeout/i.test(message)
			: /abort|timeout/i.test(message);
		if (!signal?.aborted && isRequestAbort && !message.startsWith(`Tabstack ${label} API error`)) {
			const timeoutError = new Error(`Tabstack ${label} API request timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`);
			timeoutError.name = "TimeoutError";
			throw timeoutError;
		}
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}

function parseEventStream(raw: string): Array<{ event: string; data: unknown }> {
	const events: Array<{ event: string; data: unknown }> = [];
	for (const block of raw.replace(/\r\n?/g, "\n").split(/\n\n+/)) {
		let event = "message";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length === 0) continue;
		try {
			events.push({ event, data: JSON.parse(data.join("\n")) });
		} catch {
			// A malformed frame is skipped; a missing complete event is reported as an invalid response below.
		}
	}
	return events;
}

function researchErrorMessage(data: TabstackResearchError): string {
	const nested = typeof data.error?.message === "string" ? data.error.message.trim() : "";
	const message = typeof data.message === "string" ? data.message.trim() : "";
	return nested || message || "unknown error";
}

function mapCitedPages(pages: TabstackCitedPage[] | undefined): SearchResponse["results"] {
	if (!Array.isArray(pages)) return [];
	const results: SearchResponse["results"] = [];
	for (const page of pages) {
		if (!page || typeof page.url !== "string" || page.url.trim().length === 0) continue;
		const url = page.url.trim();
		const claims = Array.isArray(page.claims) ? page.claims.filter((claim) => typeof claim === "string" && claim.trim()) : [];
		results.push({
			title: typeof page.title === "string" && page.title.trim() ? page.title.trim() : url,
			url,
			snippet: (typeof page.summary === "string" && page.summary.trim() ? page.summary : claims.join(" ")).replace(/\s+/g, " ").trim(),
		});
	}
	return results;
}

export async function searchWithTabstack(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const mode = getResearchMode();
	const apiKey = await getApiKey(options.signal);
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		// Research has no domain, recency, or result-count parameters, so only the query and mode are sent.
		// Every cited page is kept because the report cites them as [1], [2], ... in this order.
		const raw = await tabstackRequest(
			"Research",
			TABSTACK_RESEARCH_URL,
			apiKey,
			{ query, mode },
			"text/event-stream",
			RESEARCH_TIMEOUT_MS[mode],
			options.signal,
		);
		const events = parseEventStream(raw);
		const failure = events.find((item) => item.event === "error");
		if (failure) {
			throw new Error(`Tabstack Research API returned error: ${researchErrorMessage(failure.data as TabstackResearchError)}`);
		}
		const complete = events.find((item) => item.event === "complete")?.data as TabstackResearchComplete | undefined;
		if (!complete || typeof complete !== "object" || typeof complete.report !== "string") {
			throw new Error("Tabstack Research API returned an invalid response: no complete event with a report");
		}
		const response: SearchResponse = {
			answer: complete.report.trim(),
			results: mapCitedPages(complete.metadata?.citedPages),
		};
		activityMonitor.logComplete(activityId, 200);
		return response;
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (options.signal?.aborted) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}

function normalizeTimeoutMs(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return EXTRACT_TIMEOUT_MS;
	return Math.max(1, Math.floor(value));
}

export async function extractWithTabstack(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Promise<ExtractedContent | null> {
	const apiKey = await getApiKey(signal);
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	try {
		// metadata: true returns the title separately instead of as YAML front matter in the content.
		const raw = await tabstackRequest(
			"Extract",
			TABSTACK_EXTRACT_URL,
			apiKey,
			{ url, metadata: true },
			"application/json",
			normalizeTimeoutMs(options.timeoutMs),
			signal,
		);
		let data: TabstackExtractResponse;
		try {
			data = JSON.parse(raw) as TabstackExtractResponse;
		} catch (err) {
			throw new Error(`Tabstack Extract API returned invalid JSON: ${errorMessage(err)}`);
		}
		if (!data || typeof data !== "object" || typeof data.content !== "string") {
			throw new Error("Tabstack Extract API returned an unexpected response shape");
		}
		activityMonitor.logComplete(activityId, 200);
		const content = data.content.trim();
		if (!content) return null;
		const title = data.metadata && typeof data.metadata.title === "string" ? data.metadata.title.trim() : "";
		return { url, title, content, error: null };
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (signal?.aborted) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}
