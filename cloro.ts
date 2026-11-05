import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveProviderApiUrl } from "./utils.ts";

// cloro monitor API: https://cloro.dev/docs/api-reference/endpoint/monitor-google?utm_source=pi-web-access&utm_medium=byok
const CLORO_GOOGLE_URL = "https://api.cloro.dev/v1/monitor/google";
const CLORO_AIMODE_URL = "https://api.cloro.dev/v1/monitor/aimode";
const CONFIG_PATH = getWebSearchConfigPath();
// cloro scrapes the live page during the request, so allow more time than a plain search index.
const SEARCH_TIMEOUT_MS = 120_000;
// The API has no default country and requires one on every request.
const COUNTRY = "US";
const MODES = ["google", "aimode"] as const;
type CloroMode = typeof MODES[number];

interface WebSearchConfig {
	cloroBaseUrl?: unknown;
	cloroApiKey?: unknown;
	cloroMode?: unknown;
}

// Google organic results carry title/link/snippet; AI Mode sources carry label/url/description.
interface CloroEntry {
	title?: unknown;
	link?: unknown;
	snippet?: unknown;
	label?: unknown;
	url?: unknown;
	description?: unknown;
}

interface CloroResult {
	entries: CloroEntry[];
	text?: string;
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

function getMode(): CloroMode {
	const value = loadConfig().cloroMode;
	if (value === undefined) return "google";
	if (typeof value !== "string" || !MODES.includes(value as CloroMode)) {
		throw new Error(`cloroMode in ${CONFIG_PATH} must be one of: ${MODES.join(", ")}`);
	}
	return value as CloroMode;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "cloro",
		configuredValue: loadConfig().cloroApiKey,
		environmentValue: process.env.CLORO_API_KEY,
		signal,
	});
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	const apiKey = await getApiKey(signal);
	if (!apiKey) {
		throw new Error(
			"cloro API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "cloroApiKey": "your-key" }\n` +
			"  2. Set CLORO_API_KEY environment variable\n" +
			"Get a key at https://dashboard.cloro.dev/api-keys?utm_source=pi-web-access&utm_medium=byok",
		);
	}
	return apiKey;
}

interface DomainFilters {
	include: string[];
	exclude: string[];
}

function parseDomainFilter(domainFilter: string[] | undefined): DomainFilters {
	const filters: DomainFilters = { include: [], exclude: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.exclude : filters.include;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function passesDomainFilters(url: URL, filters: DomainFilters): boolean {
	if (filters.include.length === 0 && filters.exclude.length === 0) return true;
	const hostname = url.hostname.toLowerCase();
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	if (filters.exclude.some(matches)) return false;
	return filters.include.length === 0 || filters.include.some(matches);
}

function buildQuery(query: string, filters: DomainFilters): string {
	const parts = [query];
	if (filters.include.length === 1) parts.push(`site:${filters.include[0]}`);
	if (filters.include.length > 1) parts.push(`(${filters.include.map(domain => `site:${domain}`).join(" OR ")})`);
	for (const domain of filters.exclude) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

// cloro returns a Google /goto redirect, or an empty link, when it has not resolved the destination yet.
function isUnresolvedGoogleRedirect(url: URL): boolean {
	const hostname = url.hostname.toLowerCase();
	return url.pathname === "/goto" && (hostname === "google.com" || hostname.endsWith(".google.com"));
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function invalidResponse(message: string): Error {
	return new Error(`cloro returned invalid response: ${message}`);
}

function parseResponse(value: unknown, mode: CloroMode): CloroResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("expected an object envelope");
	const envelope = value as Record<string, unknown>;
	// Failures arrive as { "success": false, "error": { "code": "...", "message": "..." } }.
	const error = envelope.error as Record<string, unknown> | undefined;
	if (error && typeof error === "object" && typeof error.message === "string" && error.message.trim()) {
		throw invalidResponse(error.message.trim());
	}
	const result = envelope.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) throw invalidResponse("expected result object");
	const fields = result as Record<string, unknown>;
	if (mode === "google") {
		if (!Array.isArray(fields.organicResults)) throw invalidResponse("expected result.organicResults array");
		return { entries: fields.organicResults as CloroEntry[] };
	}
	// The request asks for markdown, which keeps list and bold formatting. Plain text is the fallback.
	const answer = typeof fields.markdown === "string" && fields.markdown.trim() ? fields.markdown : fields.text;
	if (typeof answer !== "string") throw invalidResponse("expected result.markdown or result.text string");
	return { entries: Array.isArray(fields.sources) ? fields.sources as CloroEntry[] : [], text: answer.trim() };
}

export function isCloroAvailable(): boolean {
	return hasCredentialSource({ provider: "cloro", configuredValue: loadConfig().cloroApiKey, environmentValue: process.env.CLORO_API_KEY });
}

// Neither endpoint takes a date filter in this request shape, so `recencyFilter` is not applied.
export async function searchWithCloro(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const mode = getMode();
	const apiKey = await requireApiKey(options.signal);
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	// Google Search gets the domain filters as site: clauses. AI Mode gets the plain prompt, and its sources
	// are filtered locally below. One Google request returns one results page, trimmed to numResults locally.
	const endpoint = mode === "google" ? CLORO_GOOGLE_URL : CLORO_AIMODE_URL;
	const body = mode === "google"
		? { query: buildQuery(query, filters), country: COUNTRY }
		: { prompt: query, country: COUNTRY, include: { markdown: true } };
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	let parsed: CloroResult;
	try {
		response = await fetchWithCredentialRedirects(resolveProviderApiUrl("cloro", endpoint, loadConfig().cloroBaseUrl), {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-web-access",
			},
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal,
		}, ["Authorization"]);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`cloro error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`);
		}
		let rawData: unknown;
		try {
			rawData = await response.json();
		} catch (err) {
			// Only a parse failure is invalid JSON; a dropped connection or timeout keeps its own classification.
			if (!(err instanceof SyntaxError)) throw err;
			throw new Error(`cloro returned invalid JSON: ${errorMessage(err)}`);
		}
		parsed = parseResponse(rawData, mode);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = errorMessage(err);
		const providerTimeout = timeoutSignal.aborted || (err instanceof Error && err.name === "TimeoutError");
		const outgoing = providerTimeout
			? new Error(`cloro request timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`)
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
	for (const entry of parsed.entries) {
		if (!entry || typeof entry !== "object") continue;
		const link = mode === "google" ? entry.link : entry.url;
		if (typeof link !== "string" || !link) continue;
		let resultUrl: URL;
		try {
			resultUrl = new URL(link);
		} catch {
			continue;
		}
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (isUnresolvedGoogleRedirect(resultUrl)) continue;
		if (!passesDomainFilters(resultUrl, filters)) continue;
		const title = mode === "google" ? entry.title : entry.label;
		const snippet = mode === "google" ? entry.snippet : entry.description;
		results.push({
			title: typeof title === "string" && title.trim() ? title.trim() : `Source ${results.length + 1}`,
			url: resultUrl.href,
			snippet: typeof snippet === "string" ? snippet : "",
		});
		if (results.length >= numResults) break;
	}
	const answer = parsed.text || formatSearchResultsAsAnswer(results);
	return { answer, results };
}
