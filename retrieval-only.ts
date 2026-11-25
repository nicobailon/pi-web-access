import { existsSync, readFileSync } from "node:fs";
import type { BuiltinSearchProvider } from "./gemini-search.ts";
import type { FetchProvider } from "./extract.ts";
import type { PDFProvider } from "./pdf-extract.ts";
import { getWebSearchConfigPath, isRecord } from "./utils.ts";

const RETRIEVAL_ONLY_ENV = "PI_WEB_ACCESS_RETRIEVAL_ONLY";
/** Ends the web_search and fetch_content descriptions while the policy is on, so a host can read the policy back. */
export const RETRIEVAL_ONLY_DESCRIPTION_SUFFIX = " Retrieval-only: no model calls.";

export interface RetrievalOnlyPolicy {
	enabled: boolean;
	/** Says how the policy was turned on, for error messages. */
	source?: string;
}

type RouteKind = "model" | "retrieval";

// "model": the route sends content to a model and returns what it wrote. Providers that only
// rank or snippet retrieved pages with models of their own count as retrieval.
export const SEARCH_PROVIDER_KINDS = {
	openai: "model", gemini: "model", xai: "model", mistral: "model", tabstack: "model",
	brave: "retrieval", parallel: "retrieval", "parallel-mcp": "retrieval", tinyfish: "retrieval",
	searchinfinity: "retrieval", querit: "retrieval", tavily: "retrieval", you: "retrieval",
	firecrawl: "retrieval", jina: "retrieval", searxng: "retrieval", degoog: "retrieval",
	duckduckgo: "retrieval", perplexity: "retrieval", kimi: "retrieval", exa: "retrieval",
	kagi: "retrieval", ollama: "retrieval", anysearch: "retrieval", valyu: "retrieval",
	bocha: "retrieval", baizhi: "retrieval", zai: "retrieval", keenable: "retrieval",
	ceramic: "retrieval", deepseek: "retrieval", linkup: "retrieval", ninerouter: "retrieval",
	cloudflare: "retrieval",
} as const satisfies Record<BuiltinSearchProvider, RouteKind>;

export const FETCH_PROVIDER_KINDS = {
	gemini: "model",
	http: "retrieval", firecrawl: "retrieval", crawl4ai: "retrieval", jina: "retrieval", tinyfish: "retrieval",
	querit: "retrieval", kagi: "retrieval", ollama: "retrieval", parallel: "retrieval", "parallel-mcp": "retrieval",
	brightdata: "retrieval", deepseek: "retrieval", exa: "retrieval", tabstack: "retrieval",
} as const satisfies Record<FetchProvider, RouteKind>;

// A configured endpoint is the operator's own service, so it counts as retrieval.
export const PDF_PROVIDER_KINDS = {
	gemini: "model", endpoint: "retrieval", datalab: "retrieval", unpdf: "retrieval",
} as const satisfies Record<Exclude<PDFProvider, "auto">, RouteKind>;

/** Custom providers are not in the table and count as retrieval: they are the operator's responsibility. */
export function isModelSearchProvider(provider: string): boolean {
	return (SEARCH_PROVIDER_KINDS as Record<string, RouteKind>)[provider] === "model";
}

function environmentEnabled(): boolean {
	const raw = process.env[RETRIEVAL_ONLY_ENV];
	if (raw === undefined) return false;
	const value = raw.trim().toLowerCase();
	if (value === "" || value === "0" || value === "false") return false;
	if (value === "1" || value === "true") return true;
	throw new Error(`Invalid configuration: ${RETRIEVAL_ONLY_ENV} must be 1, true, 0, or false`);
}

/** Either the environment or the config turns the policy on; neither can turn the other off. */
function resolveRetrievalOnlyPolicy(config: { retrievalOnly?: unknown }): RetrievalOnlyPolicy {
	const path = getWebSearchConfigPath();
	const fromEnvironment = environmentEnabled();
	const configured = config.retrievalOnly;
	if (configured !== undefined && typeof configured !== "boolean") {
		throw new Error(`retrievalOnly in ${path} must be a boolean`);
	}
	const sources = [
		...(fromEnvironment ? [`${RETRIEVAL_ONLY_ENV}=1`] : []),
		...(configured === true ? [`retrievalOnly: true in ${path}`] : []),
	];
	return sources.length > 0 ? { enabled: true, source: sources.join(" and ") } : { enabled: false };
}

let cachedPolicy: RetrievalOnlyPolicy | undefined;

/**
 * One policy per process: the first successful read fixes it, as tool definitions are fixed at load.
 * Pi init and the MCP core pass the config they already parsed; other first readers parse the file and
 * throw on an unparseable one without caching. A config edited after load takes effect on restart.
 */
export function getRetrievalOnlyPolicy(config?: { retrievalOnly?: unknown }): RetrievalOnlyPolicy {
	if (cachedPolicy) return cachedPolicy;
	if (config) return cachedPolicy = resolveRetrievalOnlyPolicy(config);
	const path = getWebSearchConfigPath();
	let parsed: unknown = {};
	if (existsSync(path)) {
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8"));
		} catch (err) {
			throw new Error(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return cachedPolicy = resolveRetrievalOnlyPolicy(isRecord(parsed) ? parsed : {});
}

export function retrievalOnlyError(route: string, policy = getRetrievalOnlyPolicy()): Error {
	return new Error(`${route} is blocked by the retrieval-only policy (${policy.source}): it sends content to a model.`);
}

export function retrievalOnlyExhaustedError(routeKind: string, skipped: readonly string[], policy = getRetrievalOnlyPolicy()): Error {
	return new Error(`No retrieval route is available under the retrieval-only policy (${policy.source}); ${routeKind} routes that use a model were skipped: ${skipped.join(", ")}.`);
}
