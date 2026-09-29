import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { getWebSearchConfigPath } from "./utils.ts";

// GLM Coding Plan keys are issued per site, so the user picks the matching endpoint.
const MCP_URLS = {
	global: "https://api.z.ai/api/mcp/web_search_prime/mcp",
	china: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
} as const;
const RECENCY = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" } as const;
const SEARCH_TIMEOUT_MS = 60_000;
const CONFIG_PATH = getWebSearchConfigPath();

function loadConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		// JSON parser errors may include a fragment containing a literal key.
		throw new Error(`Invalid configuration in ${CONFIG_PATH}: expected a JSON object`);
	}
}

function credentialOptions(config: Record<string, unknown>) {
	return { provider: "Z.ai", configuredValue: config.zaiApiKey, environmentValue: process.env.ZAI_API_KEY };
}

function endpointUrl(config: Record<string, unknown>): string {
	const endpoint = config.zaiEndpoint ?? "global";
	if (endpoint !== "global" && endpoint !== "china") {
		throw new Error(`zaiEndpoint in ${CONFIG_PATH} must be "global" or "china"`);
	}
	return MCP_URLS[endpoint];
}

export function isZaiAvailable(): boolean {
	return hasCredentialSource(credentialOptions(loadConfig()));
}

function searchArguments(query: string, options: SearchOptions): Record<string, unknown> {
	if (!query.trim()) throw new Error("Z.ai search query must not be empty");
	const domains = (options.domainFilter ?? []).map((raw) => raw.trim()).filter(Boolean);
	if (domains.length > 1 || domains.some((raw) => raw.startsWith("-"))) {
		throw new Error("Z.ai domainFilter supports a single included domain");
	}
	const domain = domains[0] === undefined ? undefined : normalizeDomain(domains[0]);
	if (domain === null) throw new Error("Z.ai domain filter must contain a valid domain");
	return {
		search_query: query.trim(),
		...(options.recencyFilter ? { search_recency_filter: RECENCY[options.recencyFilter] } : {}),
		...(domain ? { search_domain_filter: domain } : {}),
	};
}

/** The tool returns its result list as JSON text, sometimes encoded twice. */
function parseResults(text: string, limit: number, domain: string | undefined): SearchResponse["results"] {
	let value: unknown = JSON.parse(text);
	if (typeof value === "string") value = JSON.parse(value);
	if (!Array.isArray(value)) throw new Error("Z.ai returned invalid response: expected a result list");
	const results: SearchResponse["results"] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const { link, title, content } = entry as Record<string, unknown>;
		if (typeof link !== "string") continue;
		let url: URL;
		try {
			url = new URL(link);
		} catch {
			continue;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") continue;
		// The remote filter is undocumented, so enforce it locally too.
		const host = url.hostname.toLowerCase().replace(/\.+$/, "");
		if (domain && host !== domain && !host.endsWith(`.${domain}`)) continue;
		results.push({
			title: typeof title === "string" && title.trim() ? title.trim() : `Source ${results.length + 1}`,
			url: url.href,
			snippet: typeof content === "string" ? content : "",
		});
		if (results.length >= limit) break;
	}
	return results;
}

export async function searchWithZai(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const config = loadConfig();
	const mcpUrl = endpointUrl(config);
	const args = searchArguments(query, options);
	const limit = normalizeSearchResultCount(options.numResults);
	const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
	if (signal.aborted) throw new Error("Aborted");
	const apiKey = await resolveCredential({ ...credentialOptions(config), signal });
	if (!apiKey) throw new Error("Z.ai API key not found. Set ZAI_API_KEY or zaiApiKey in web-search.json with a GLM Coding Plan key.");
	let headers: Headers;
	try { headers = new Headers({ Authorization: `Bearer ${apiKey}` }); }
	catch { throw new Error("Z.ai credential resolution failed: invalid-header-value"); }
	// Load the protocol client only when this explicit provider is selected.
	const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
		import("@modelcontextprotocol/sdk/client/index.js"),
		import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
	]);
	let cleaningUp = false;
	const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
		requestInit: { headers },
		fetch: async (url, init) => {
			// Fixed endpoint, no redirects: neither credentials nor session IDs can
			// be forwarded to another origin (including MCP discovery redirects).
			if (String(url) !== mcpUrl) throw new Error("Z.ai endpoint changed unexpectedly");
			const requestSignal = cleaningUp ? AbortSignal.timeout(1_500) : signal;
			return fetch(url, { ...init, redirect: "error", signal: !cleaningUp && init?.signal ? AbortSignal.any([init.signal, requestSignal]) : requestSignal });
		},
		reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
	});
	const client = new Client({ name: "pi-web-access-zai", version: "1.0.0" });
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		await client.connect(transport, { signal, timeout: SEARCH_TIMEOUT_MS });
		// The live China server lists `web_search_prime` while both sites document
		// `webSearchPrime`, so call whichever name this server exposes.
		const { tools } = await client.listTools(undefined, { signal, timeout: SEARCH_TIMEOUT_MS });
		const toolName = tools.find((tool) => tool.name === "web_search_prime" || tool.name === "webSearchPrime")?.name;
		if (!toolName) throw new Error("Z.ai returned invalid response: web search tool not listed");
		const result = await client.callTool({ name: toolName, arguments: args }, undefined, { signal, timeout: SEARCH_TIMEOUT_MS });
		if (result.isError) throw new Error("Z.ai search tool returned an error");
		const text = (Array.isArray(result.content) ? result.content : []).find((item) => item.type === "text" && typeof item.text === "string");
		if (!text) throw new Error("Z.ai returned invalid response: no search text");
		const results = parseResults(text.text as string, limit, args.search_domain_filter as string | undefined);
		activityMonitor.logComplete(activityId, 200);
		return { answer: formatSearchResultsAsAnswer(results), results };
	} catch (err) {
		let message: string;
		if (options.signal?.aborted) message = "Aborted";
		else if (timeoutSignal.aborted) message = "Z.ai request timed out after 60s";
		else {
			const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
			// Never expose remote HTTP/JSON-RPC bodies or nested SDK errors: they
			// can echo credentials in plain, encoded or transformed form.
			message = typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599
				? `Z.ai HTTP ${code} request failed; check your GLM Coding Plan key, zaiEndpoint and plan quota`
				: err instanceof TypeError ? "Z.ai network request failed"
				: err instanceof SyntaxError || code === -32700 || code === -32602 ? "Z.ai returned invalid response"
				: err instanceof Error && /^Z\.ai (search tool returned an error|returned invalid response:)/.test(err.message) ? err.message
				: "Z.ai MCP request failed; check your connection and GLM Coding Plan key";
		}
		activityMonitor.logError(activityId, redactCredential(message, apiKey));
		throw new Error(message);
	} finally {
		cleaningUp = true;
		// Best effort, separately bounded DELETE; always close the local streams.
		try { await transport.terminateSession(); } catch { /* Server may not support DELETE. */ }
		await client.close();
	}
}
