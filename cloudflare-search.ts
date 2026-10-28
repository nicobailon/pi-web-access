import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";

// Cloudflare Web Search API (https://developers.cloudflare.com/web-search/): one endpoint that
// runs a query on Ceramic, Exa, or Linkup through an AI Gateway and returns one result shape.
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const MAX_REQUEST_RESULTS = 10;
// The API rejects longer queries. String length counts UTF-16 units, which is never less than
// the Unicode character count, so a query that passes this check is not too long either way.
const MAX_QUERY_CHARS = 1024;
const MAX_SNIPPET_CHARS = 500;
const DEFAULT_GATEWAY_ID = "default";
export const CLOUDFLARE_SEARCH_PROVIDERS = ["ceramic", "exa", "linkup"] as const;
type CloudflareSearchProvider = typeof CLOUDFLARE_SEARCH_PROVIDERS[number];

interface WebSearchConfig {
	cloudflareApiKey?: unknown;
	cloudflareAccountId?: unknown;
	cloudflareGatewayId?: unknown;
	cloudflareSearchProvider?: unknown;
}

interface CloudflareSearchItem {
	url?: unknown;
	title?: unknown;
	description?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	let parsed: unknown;
	// JSON parse errors can quote credentials from the file, so they are not echoed.
	try { parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch { parsed = undefined; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

function setting(envValue: string | undefined, configValue: unknown, name: string): string | undefined {
	const value = envValue?.trim() ? envValue : configValue;
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new Error(`${name} in ${CONFIG_PATH} must be a string`);
	return value.trim() || undefined;
}

function accountId(): string | undefined {
	return setting(process.env.CLOUDFLARE_ACCOUNT_ID, loadConfig().cloudflareAccountId, "cloudflareAccountId");
}

function gatewayId(): string {
	return setting(process.env.CLOUDFLARE_GATEWAY_ID, loadConfig().cloudflareGatewayId, "cloudflareGatewayId") ?? DEFAULT_GATEWAY_ID;
}

function searchProvider(): CloudflareSearchProvider {
	const value = setting(process.env.CLOUDFLARE_SEARCH_PROVIDER, loadConfig().cloudflareSearchProvider, "cloudflareSearchProvider") ?? "ceramic";
	const provider = value.toLowerCase();
	if (!(CLOUDFLARE_SEARCH_PROVIDERS as readonly string[]).includes(provider)) {
		throw new Error(`cloudflareSearchProvider must be one of ${CLOUDFLARE_SEARCH_PROVIDERS.join(", ")}; got ${JSON.stringify(value)}`);
	}
	return provider as CloudflareSearchProvider;
}

export function isCloudflareSearchAvailable(): boolean {
	return !!accountId() && hasCredentialSource({ provider: "Cloudflare", configuredValue: loadConfig().cloudflareApiKey, environmentValue: process.env.CLOUDFLARE_API_KEY });
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
	const hostname = url.hostname.toLowerCase();
	const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
	if (filters.exclude.some(matches)) return false;
	return filters.include.length === 0 || filters.include.some(matches);
}

// The API has no domain parameters. Ceramic documents `site:` with `OR`, so allowed domains go
// into its query; for every provider the returned results are filtered locally as well.
// A query over the limit fails here instead of being cut, since cutting can break a `site:` clause.
function buildQuery(query: string, provider: CloudflareSearchProvider, filters: DomainFilters): string {
	const sites = provider === "ceramic" ? filters.include.map(domain => `site:${domain}`) : [];
	const built = sites.length === 0 ? query : `${query} ${sites.length === 1 ? sites[0] : `(${sites.join(" OR ")})`}`;
	if (built.length > MAX_QUERY_CHARS) {
		throw new Error(`Cloudflare Web Search invalid request: the query is ${built.length} characters${sites.length > 0 ? " with domain filters" : ""}; Cloudflare Web Search accepts at most ${MAX_QUERY_CHARS}`);
	}
	return built;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

// Error bodies come in three shapes (see cloudflare/agents packages/agents/src/web/search/source.ts):
// gateway `{ ok: false, error: { code, status } }`, validation `{ success: false, errors: [{ message }],
// messages: [{ message, path }] }`, and gateway setup `{ success: false, error: [{ message }], message }`.
function describeError(status: number, body: string): { status: number; detail: string } {
	let parsed: unknown;
	try { parsed = JSON.parse(body); } catch { return { status, detail: body }; }
	if (!isRecord(parsed)) return { status, detail: body };
	const error = parsed.error;
	if (isRecord(error) && typeof error.code === "string") {
		const errorStatus = typeof error.status === "number" ? error.status : status;
		// Newer responses carry a readable `message` that says how to fix the problem.
		if (text(error.message)) return { status: errorStatus, detail: `${error.code}: ${text(error.message)}` };
		const hint = error.code === "web_search_payment_required"
			? " (no AI Gateway credits and no provider key stored on the gateway)"
			: error.code === "web_search_gateway_not_configured" ? " (create the AI Gateway or set cloudflareGatewayId)" : "";
		return { status: errorStatus, detail: `${error.code}${hint}` };
	}
	const entries = [...(Array.isArray(parsed.errors) ? parsed.errors : []), ...(Array.isArray(error) ? error : [])];
	const issues = Array.isArray(parsed.messages) ? parsed.messages : [];
	const parts = [
		...entries.map(entry => isRecord(entry) ? text(entry.message) : ""),
		...issues.map(issue => {
			if (!isRecord(issue) || !text(issue.message)) return "";
			return Array.isArray(issue.path) && issue.path.length ? `${issue.path.join(".")}: ${text(issue.message)}` : text(issue.message);
		}),
	].filter(Boolean);
	return { status, detail: parts.join("; ") || text(parsed.message) || body };
}

function parseItems(value: unknown): CloudflareSearchItem[] {
	// The documented success body is `{ items, metadata }`; accept the v4 `{ result }` envelope too.
	const body = isRecord(value) && isRecord(value.result) && !Array.isArray(value.items) ? value.result : value;
	if (!isRecord(body) || !Array.isArray(body.items)) throw new Error("Cloudflare Web Search returned invalid response: expected items array");
	return body.items as CloudflareSearchItem[];
}

// The API has no date filter, so `recencyFilter` is not applied.
export async function searchWithCloudflare(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const account = accountId();
	if (!account) {
		throw new Error(
			"Cloudflare account ID not found. Set cloudflareAccountId in " + CONFIG_PATH + " or CLOUDFLARE_ACCOUNT_ID, " +
			"with cloudflareApiKey or CLOUDFLARE_API_KEY (an API token with Workers AI Read and AI Gateway Read)",
		);
	}
	const apiKey = await resolveCredential({ provider: "Cloudflare", configuredValue: loadConfig().cloudflareApiKey, environmentValue: process.env.CLOUDFLARE_API_KEY, signal: options.signal });
	if (!apiKey) {
		throw new Error(
			"Cloudflare API key not found. Set cloudflareApiKey in " + CONFIG_PATH + " or CLOUDFLARE_API_KEY " +
			"to an API token with Workers AI Read and AI Gateway Read",
		);
	}
	const provider = searchProvider();
	const numResults = normalizeSearchResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const hasDomainFilters = filters.include.length > 0 || filters.exclude.length > 0;
	const body = {
		query: buildQuery(query, provider, filters),
		provider,
		// Results are filtered locally when domains are set, so ask for the most the API allows.
		limit: hasDomainFilters ? MAX_REQUEST_RESULTS : Math.min(MAX_REQUEST_RESULTS, numResults),
		options: { gateway: { id: gatewayId() } },
	};
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/websearch/`;
	const activityId = activityMonitor.logStart({ type: "api", query });
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let status = 0;
	let items: CloudflareSearchItem[];
	try {
		const response = await fetchWithCredentialRedirects(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
		}, ["Authorization"]);
		status = response.status;
		if (!response.ok) {
			const error = describeError(response.status, await response.text());
			// The status stays in the message so searchRouting can classify quota and transient failures.
			throw new Error(`Cloudflare Web Search error ${error.status}: ${redactCredential(error.detail, apiKey).slice(0, 300)}`);
		}
		// Syntax errors can quote the body, so they are not echoed.
		const data = await response.json().catch((err: unknown) => { throw err instanceof SyntaxError ? new Error("Cloudflare Web Search returned invalid JSON") : err; });
		items = parseItems(data);
	} catch (err) {
		// Node reports the deadline as "aborted due to timeout", which routing would treat as a cancellation.
		if (!options.signal?.aborted && (timeout.aborted || (err instanceof Error && err.name === "TimeoutError"))) {
			const message = `Cloudflare Web Search request timed out after ${SEARCH_TIMEOUT_MS / 1000}s`;
			activityMonitor.logError(activityId, message);
			throw new Error(message);
		}
		const message = redactCredential(err instanceof Error ? err.message : String(err), apiKey);
		activityMonitor.logError(activityId, message);
		if (err instanceof Error && err.message === message) throw err;
		throw new Error(message);
	}
	activityMonitor.logComplete(activityId, status);
	const results: SearchResponse["results"] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (!isRecord(item) || typeof item.url !== "string") continue;
		let resultUrl: URL;
		try { resultUrl = new URL(item.url.trim()); } catch { continue; }
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		if (!passesDomainFilters(resultUrl, filters) || seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		results.push({
			title: text(item.title) || resultUrl.href,
			url: resultUrl.href,
			snippet: text(item.description).slice(0, MAX_SNIPPET_CHARS),
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchResultsAsAnswer(results), results };
}
