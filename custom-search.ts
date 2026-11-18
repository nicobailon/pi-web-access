import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { applyDomainFilter } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { fetchWithCredentialRedirects, isRecord, resolveApiBaseUrl } from "./utils.ts";

export interface CustomSearchProviderConfig {
	url: string;
	method: "GET" | "POST";
	apiKey?: string;
	apiKeyHeader?: string;
	apiKeyPrefix?: string;
	apiKeyQuery?: string;
	headers: Record<string, string>;
	query: Record<string, string>;
	body?: Record<string, unknown>;
	results: string;
	fields: { title: string; url: string; snippet?: string };
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ENTRY_KEYS = new Set(["url", "method", "apiKey", "apiKeyHeader", "apiKeyPrefix", "apiKeyQuery", "headers", "query", "body", "results", "fields"]);
const SEARCH_TIMEOUT_MS = 60_000;

function optionalString(entry: Record<string, unknown>, key: string, label: string): string | undefined {
	const value = entry[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label}.${key} must be a non-empty string`);
	return value;
}

function stringMap(entry: Record<string, unknown>, key: string, label: string): Record<string, string> {
	const value = entry[key];
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${label}.${key} must be an object of strings`);
	for (const [name, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new Error(`${label}.${key}.${name} must be a string`);
	}
	return value as Record<string, string>;
}

function parseEntry(value: unknown, label: string): CustomSearchProviderConfig {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const unknown = Object.keys(value).filter((key) => !ENTRY_KEYS.has(key));
	if (unknown.length > 0) throw new Error(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
	const rawUrl = optionalString(value, "url", label);
	if (rawUrl === undefined) throw new Error(`${label}.url is required`);
	// Validated like a base URL, but sent exactly as configured: a trailing slash can be part of the endpoint.
	resolveApiBaseUrl({ configKey: `${label}.url`, configuredValue: rawUrl, defaultValue: rawUrl, environmentKey: "", environmentValue: undefined });
	const url = new URL(rawUrl.trim()).href;
	const method = value.method ?? "GET";
	if (method !== "GET" && method !== "POST") throw new Error(`${label}.method must be "GET" or "POST"`);
	const apiKey = optionalString(value, "apiKey", label);
	const apiKeyHeader = optionalString(value, "apiKeyHeader", label);
	const apiKeyPrefix = value.apiKeyPrefix === undefined ? undefined : typeof value.apiKeyPrefix === "string" ? value.apiKeyPrefix : null;
	if (apiKeyPrefix === null) throw new Error(`${label}.apiKeyPrefix must be a string`);
	const apiKeyQuery = optionalString(value, "apiKeyQuery", label);
	if (apiKey === undefined && (apiKeyHeader || apiKeyQuery || apiKeyPrefix !== undefined)) {
		throw new Error(`${label} sets where the API key goes but has no apiKey`);
	}
	if (apiKey !== undefined && (apiKeyHeader === undefined) === (apiKeyQuery === undefined)) {
		throw new Error(`${label}.apiKey needs exactly one of apiKeyHeader or apiKeyQuery`);
	}
	if (apiKeyPrefix !== undefined && apiKeyHeader === undefined) throw new Error(`${label}.apiKeyPrefix needs apiKeyHeader`);
	if (value.body !== undefined) {
		if (method !== "POST") throw new Error(`${label}.body needs method "POST"`);
		if (!isRecord(value.body)) throw new Error(`${label}.body must be a JSON object`);
	}
	const results = value.results ?? "";
	if (typeof results !== "string") throw new Error(`${label}.results must be a string path`);
	const fields = value.fields;
	if (!isRecord(fields)) throw new Error(`${label}.fields must be an object with title and url`);
	const unknownFields = Object.keys(fields).filter((key) => key !== "title" && key !== "url" && key !== "snippet");
	if (unknownFields.length > 0) throw new Error(`${label}.fields has unknown field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`);
	const title = optionalString(fields, "title", `${label}.fields`);
	const resultUrl = optionalString(fields, "url", `${label}.fields`);
	if (title === undefined || resultUrl === undefined) throw new Error(`${label}.fields needs title and url`);
	const snippet = optionalString(fields, "snippet", `${label}.fields`);
	return {
		url,
		method,
		...(apiKey !== undefined ? { apiKey } : {}),
		...(apiKeyHeader !== undefined ? { apiKeyHeader } : {}),
		...(apiKeyPrefix !== undefined ? { apiKeyPrefix } : {}),
		...(apiKeyQuery !== undefined ? { apiKeyQuery } : {}),
		headers: stringMap(value, "headers", label),
		query: stringMap(value, "query", label),
		...(value.body !== undefined ? { body: value.body as Record<string, unknown> } : {}),
		results,
		fields: { title, url: resultUrl, ...(snippet !== undefined ? { snippet } : {}) },
	};
}

/** Validates `customSearchProviders`; `reserved` holds names a custom provider may not take. */
export function parseCustomSearchProviders(value: unknown, reserved: readonly string[], configPath: string): Map<string, CustomSearchProviderConfig> {
	const providers = new Map<string, CustomSearchProviderConfig>();
	if (value === undefined) return providers;
	if (!isRecord(value)) throw new Error(`customSearchProviders in ${configPath} must be an object`);
	for (const [name, entry] of Object.entries(value)) {
		const label = `customSearchProviders.${name} in ${configPath}`;
		if (!NAME_PATTERN.test(name)) throw new Error(`${label}: a provider name may contain only lowercase letters, digits, and "-"`);
		if (name === "auto" || name === "all" || reserved.includes(name)) throw new Error(`${label}: "${name}" is already a built-in provider name`);
		try {
			providers.set(name, parseEntry(entry, `customSearchProviders.${name}`));
		} catch (err) {
			const message = errorMessage(err);
			throw new Error(message.includes(configPath) ? message : `${message} (in ${configPath})`);
		}
	}
	return providers;
}

export function isCustomSearchProviderAvailable(name: string, config: CustomSearchProviderConfig): boolean {
	return config.apiKey === undefined || hasCredentialSource({ provider: name, configuredValue: config.apiKey });
}

function fill(template: string, query: string, count: number): string {
	return template.replace(/\{(query|count)\}/g, (_match, key: string) => key === "query" ? query : String(count));
}

function fillBody(value: unknown, query: string, count: number): unknown {
	if (value === "{count}") return count;
	if (typeof value === "string") return fill(value, query, count);
	if (Array.isArray(value)) return value.map((item) => fillBody(item, query, count));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillBody(item, query, count)]));
	return value;
}

function readPath(value: unknown, path: string): unknown {
	if (path === "") return value;
	let current = value;
	for (const key of path.split(".")) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Recency has no generic request form, so `recencyFilter` is not applied; domain filters are applied to the returned URLs.
export async function searchWithCustomProvider(
	name: string,
	config: CustomSearchProviderConfig,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const apiKey = config.apiKey === undefined
		? null
		: await resolveCredential({ provider: name, configuredValue: config.apiKey, signal: options.signal });
	if (config.apiKey !== undefined && !apiKey) throw new Error(`${name} API key not found: set apiKey in customSearchProviders.${name}`);
	const numResults = normalizeSearchResultCount(options.numResults);
	// Domain filters run on the returned URLs, so ask for a few extra results.
	const count = options.domainFilter?.length ? Math.min(20, numResults + 5) : numResults;
	const url = new URL(config.url);
	for (const [key, value] of Object.entries(config.query)) url.searchParams.set(key, fill(value, query, count));
	if (apiKey && config.apiKeyQuery) url.searchParams.set(config.apiKeyQuery, apiKey);
	const redact = (text: string) => redactCredential(text, apiKey);
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let data: unknown;
	try {
		// Built inside the try: an invalid header value is quoted, key included, in the error, so it must be redacted.
		// Headers matches names case-insensitively, so a configured "content-type" isn't sent twice.
		const headers = new Headers({ Accept: "application/json", ...config.headers });
		if (config.body !== undefined) headers.set("Content-Type", "application/json");
		if (apiKey && config.apiKeyHeader) headers.set(config.apiKeyHeader, (config.apiKeyPrefix ?? "") + apiKey);
		response = await fetchWithCredentialRedirects(url.toString(), {
			method: config.method,
			headers,
			...(config.body !== undefined ? { body: JSON.stringify(fillBody(config.body, query, count)) } : {}),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, config.apiKeyHeader ? [config.apiKeyHeader] : [], config.apiKeyQuery ? [config.apiKeyQuery] : []);
		if (!response.ok) {
			throw new Error(`${name} API error ${response.status}: ${redact(await response.text()).slice(0, 300)}`);
		}
		try {
			data = await response.json();
		} catch (err) {
			// Only a parse failure is invalid JSON; a dropped connection keeps its own classification.
			// The parser's message quotes the body, which can hold a partial key that redaction can't match.
			if (!(err instanceof SyntaxError)) throw err;
			throw new Error(`${name} API returned invalid JSON`);
		}
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		// A proxy can turn the provider timeout into a plain abort; name it so routing falls back.
		if (timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError")) {
			const timedOut = new Error(`${name} request timed out after ${SEARCH_TIMEOUT_MS / 1000}s`);
			activityMonitor.logError(activityId, timedOut.message);
			throw timedOut;
		}
		const message = redact(errorMessage(err));
		activityMonitor.logError(activityId, message);
		if (message === errorMessage(err)) throw err;
		const redacted = new Error(message);
		if (err instanceof Error) redacted.name = err.name;
		throw redacted;
	}
	activityMonitor.logComplete(activityId, response.status);
	// SERP APIs often omit the results array when nothing matched.
	const entries = readPath(data, config.results) ?? [];
	if (!Array.isArray(entries)) {
		throw new Error(`${name} API returned invalid response: expected an array at ${config.results ? `"${config.results}"` : "the top level"}`);
	}
	const mapped: SearchResponse["results"] = [];
	for (const entry of entries) {
		const title = readPath(entry, config.fields.title);
		const link = readPath(entry, config.fields.url);
		if (typeof title !== "string" || !title.trim() || typeof link !== "string") continue;
		const parsed = URL.parse(link.trim());
		if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) continue;
		const snippet = config.fields.snippet === undefined ? undefined : readPath(entry, config.fields.snippet);
		mapped.push({ title: title.trim(), url: parsed.href, snippet: typeof snippet === "string" ? snippet.trim() : "" });
	}
	const results = applyDomainFilter(mapped, options.domainFilter).slice(0, numResults);
	return { answer: formatSearchResultsAsAnswer(results), results };
}
