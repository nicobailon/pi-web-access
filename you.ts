import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const YOU_SEARCH_URL = "https://api.you.com/api/v1/search";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

interface WebSearchConfig {
	youApiKey?: unknown;
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

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "You.com",
		configuredValue: loadConfig().youApiKey,
		environmentValue: process.env.YOU_API_KEY ?? process.env.YDC_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"You.com API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "youApiKey": "your-key" }\n` +
			"  2. Set YOU_API_KEY or YDC_API_KEY environment variable\n" +
			"Get a key at https://you.com/platform/api-keys",
		);
	}
	return apiKey;
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 10;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function mapFreshness(value: SearchOptions["recencyFilter"]): string {
	switch (value) {
		case "day": return "day";
		case "week": return "week";
		case "month": return "month";
		case "year": return "year";
		default: return "";
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`You.com API returned invalid response: ${message}`);
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function parseSearchResponse(value: unknown): { results: SearchResponse["results"] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	const web = envelope.web;
	const items = (typeof web === "object" && web !== null && !Array.isArray(web))
		? (web as Record<string, unknown>).results
		: undefined;
	if (!Array.isArray(items)) throw invalidResponse("missing web.results array");
	const results: SearchResponse["results"] = [];
	for (const item of items) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		const url = firstString(entry.url, entry.link);
		if (!url) continue;
		const title = firstString(entry.title, entry.name) ?? url;
		const snippet = firstString(entry.description, entry.snippet, entry.text) ?? "";
		results.push({ title, url, snippet });
	}
	return { results };
}

export function isYouAvailable(): boolean {
	return hasCredentialSource({
		provider: "You.com",
		configuredValue: loadConfig().youApiKey,
		environmentValue: process.env.YOU_API_KEY ?? process.env.YDC_API_KEY,
	});
}

export async function searchWithYou(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeCount(options.numResults);
	const freshness = mapFreshness(options.recencyFilter);
	const activityId = activityMonitor.logStart({ type: "api", query });

	const params = new URLSearchParams({ query, num_web_results: String(numResults) });
	if (freshness) params.set("freshness", freshness);

	let response: Response;
	const url = `${YOU_SEARCH_URL}?${params}`;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`You.com API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let rawData: unknown;
	try {
		rawData = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`You.com API returned invalid JSON: ${errorMessage(err)}`);
	}

	let parsed: { results: SearchResponse["results"] };
	try {
		parsed = parseSearchResponse(rawData);
	} catch (err) {
		const message = errorMessage(err);
		activityMonitor.logError(activityId, message);
		if (message === errorMessage(err)) throw err;
		const redactedError = new Error(message);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	activityMonitor.logComplete(activityId, response.status);
	const results = parsed.results.slice(0, numResults);
	return { answer: formatSearchResultsAsAnswer(results), results };
}