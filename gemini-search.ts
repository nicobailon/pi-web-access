import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { awaitWithAbort } from "./abortable.ts";
import { activityMonitor } from "./activity.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { getApiKey, getVersionedApiBase, fetchGeminiApi, isGatewayConfigured, isGeminiApiAvailable, redactGeminiApiResponse } from "./gemini-api.ts";
import { isGeminiAdcAvailable } from "./gemini-adc.ts";
import { getGeminiWebAvailabilityDiagnostic, isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import { judgeOffTopic, OFFTOPIC_JUDGE_MODELS, type OffTopicJudgeModel } from "./offtopic-judge.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isBraveAvailable, searchWithBrave } from "./brave.ts";
import {
	isCurrentModelHostedSearchEligible,
	isOpenAISearchAvailable,
	isOpenAISubscriptionModelSelected,
	OpenAIAlphaSearchUnsupportedError,
	searchWithCurrentModelOpenAI,
	searchWithOpenAI,
} from "./openai-search.ts";
import { isParallelAvailable, searchWithParallel } from "./parallel.ts";
import { isParallelMcpAvailable, searchWithParallelMcp } from "./parallel-mcp.ts";
import { isTinyFishAvailable, searchWithTinyFish } from "./tinyfish.ts";
import { isSearch1APIAvailable, searchWithSearch1API } from "./search1api.ts";
import { isSearchinfinityAvailable, searchWithSearchinfinity } from "./searchinfinity.ts";
import { isQueritAvailable, searchWithQuerit } from "./querit.ts";
import { isTavilyAvailable, searchWithTavily } from "./tavily.ts";
import { isYouAvailable, searchWithYou } from "./you.ts";
import { isFirecrawlAvailable, searchWithFirecrawl } from "./firecrawl.ts";
import { isJinaSearchAvailable, searchWithJina } from "./jina-search.ts";
import { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts";
import { isKagiAvailable, searchWithKagi } from "./kagi.ts";
import { isBochaAvailable, searchWithBocha } from "./bocha.ts";
import { isOllamaAvailable, searchWithOllama } from "./ollama.ts";
import { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts";
import { isDegoogAvailable, searchWithDegoog } from "./degoog.ts";
import { isDuckDuckGoAvailable, searchWithDuckDuckGo } from "./duckduckgo.ts";
import { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts";
import { isXcrawlAvailable, searchWithXCrawl } from "./xcrawl.ts";
import { isXaiSearchAvailable, searchWithXai } from "./xai-search.ts";
import { isBrightDataAvailable, searchWithBrightData } from "./brightdata.ts";
import { isSerpBaseAvailable, searchWithSerpBase } from "./serpbase.ts";
import { isSerpApiAvailable, searchWithSerpApi } from "./serpapi.ts";
import { isSerperAvailable, searchWithSerper } from "./serper.ts";
import { isSerplyAvailable, searchWithSerply } from "./serply.ts";
import { isBaizhiAvailable, searchWithBaizhi } from "./baizhi.ts";
import { isZaiAvailable, searchWithZai } from "./zai.ts";
import { isValyuAvailable, searchWithValyu } from "./valyu.ts";
import { isKeenableAvailable, searchWithKeenable } from "./keenable.ts";
import { isCeramicAvailable, searchWithCeramic } from "./ceramic.ts";
import { isLinkupAvailable, searchWithLinkup } from "./linkup.ts";
import { isNineRouterAvailable, searchWithNineRouter } from "./ninerouter.ts";
import { isDeepSeekAvailable, searchWithDeepSeek } from "./deepseek.ts";
import { isKimiSearchAvailable, searchWithKimi } from "./kimi-search.ts";
import { isMistralAvailable, searchWithMistral } from "./mistral-search.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export const RESOLVED_SEARCH_PROVIDERS = ["openai", "brave", "parallel", "parallel-mcp", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "you", "firecrawl", "jina", "searxng", "degoog", "duckduckgo", "perplexity", "gemini", "kimi", "exa", "serpdive", "kagi", "ollama", "anysearch", "xai", "mistral", "brightdata", "serpbase", "serpapi", "serper", "serply", "valyu", "bocha", "xcrawl", "baizhi", "zai", "keenable", "ceramic", "deepseek", "linkup", "ninerouter"] as const;
export const SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS] as const;

export type ResolvedSearchProvider = typeof RESOLVED_SEARCH_PROVIDERS[number];
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[];
export type ProviderAvailability = { all: boolean } & Record<ResolvedSearchProvider, boolean>;
export type SearchProviderErrorKind =
	| "transient"
	| "quota"
	| "network"
	| "credential"
	| "config"
	| "auth"
	| "invalid-request"
	| "invalid-response"
	| "unsupported"
	| "aborted"
	| "unknown";

export interface SearchRoutingConfig {
	providers: ResolvedSearchProvider[];
	useCurrentModel?: boolean;
	fallbackOn: Array<typeof VALID_ROUTING_KINDS[number]>;
	/** Total budget for one routed search across every candidate, in milliseconds. */
	timeoutMs?: number;
	/** Classifier that judges the "off-topic" fallback; required when fallbackOn lists it. */
	offTopicModel?: OffTopicJudgeModel;
}

export class SearchProviderError extends Error {
	readonly provider: ResolvedSearchProvider;
	readonly kind: SearchProviderErrorKind;
	readonly status?: number;
	readonly causeError: unknown;

	constructor(
		provider: ResolvedSearchProvider,
		kind: SearchProviderErrorKind,
		message: string,
		status: number | undefined,
		cause: unknown,
	) {
		super(`${provider} search failed (${kind}): ${message}`);
		this.name = "SearchProviderError";
		this.provider = provider;
		this.kind = kind;
		this.status = status;
		this.causeError = cause;
	}
}

export interface ProviderSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

export interface ProviderSearchFailure {
	provider: ResolvedSearchProvider;
	error: string;
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider | "all";
	providerResponses?: ProviderSearchResponse[];
	providerErrors?: ProviderSearchFailure[];
}

const CONFIG_PATH = getWebSearchConfigPath();
const DEFAULT_SEARCH_MODEL = "gemini-3.6-flash";
// Explicit-only providers (Parallel MCP, degoog, DuckDuckGo, Kimi, AnySearch, XCrawl, xAI, Mistral, Bright Data, SerpBase, SerpApi, Serper, Serply, You.com, Valyu, Baizhi, Z.ai, Keenable, Ceramic, DeepSeek, Linkup, 9router) are deliberately absent:
// `all` must never fan out to an opt-in or paid provider without the user asking for it.
export const ALL_SEARCH_PROVIDERS: ResolvedSearchProvider[] = ["searxng", "openai", "exa", "brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "firecrawl", "jina", "serpdive", "kagi", "ollama", "perplexity", "gemini", "bocha"];
const VALID_ROUTING_KINDS = ["transient", "quota", "network", "invalid-response", "unsupported", "empty", "domain-miss", "off-topic"] as const;
const MAX_ROUTING_TIMEOUT_MS = 600_000;

type SearchConfig = {
	searchProvider: SearchProviderSelection;
	searchProviderConfigured: boolean;
	searchRouting?: SearchRoutingConfig;
	searchModel?: string;
	allowedProviders?: ResolvedSearchProvider[];
};

let cachedSearchConfig: SearchConfig | null = null;

function getSearchConfig(): SearchConfig {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto", searchProviderConfigured: false };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const searchModel = normalizeSearchModel(raw.searchModel);
	const webSearch = raw.webSearch;
	if (webSearch !== undefined && (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch))) {
		throw new Error(`webSearch in ${CONFIG_PATH} must be an object`);
	}
	const allowedProviders = webSearch && Object.hasOwn(webSearch, "allowedProviders")
		? normalizeResolvedProviderList((webSearch as Record<string, unknown>).allowedProviders, `webSearch.allowedProviders in ${CONFIG_PATH}`)
		: undefined;
	const searchProviderConfigured = Object.hasOwn(raw, "searchProvider") || Object.hasOwn(raw, "provider");
	const searchProvider = normalizeSearchProviderSelection(raw.searchProvider ?? raw.provider, `provider in ${CONFIG_PATH}`);
	const searchRouting = Object.hasOwn(raw, "searchRouting") ? normalizeSearchRouting(raw.searchRouting) : undefined;
	if (allowedProviders) {
		if (Object.hasOwn(raw, "searchProvider")) {
			assertSearchProviderSelectionAllowed(normalizeSearchProviderSelection(raw.searchProvider), `searchProvider in ${CONFIG_PATH}`, allowedProviders);
		}
		if (Object.hasOwn(raw, "provider")) {
			assertSearchProviderSelectionAllowed(normalizeSearchProviderSelection(raw.provider), `provider in ${CONFIG_PATH}`, allowedProviders);
		}
		if (searchRouting) assertSearchProviderSelectionAllowed(searchRouting.providers, `searchRouting.providers in ${CONFIG_PATH}`, allowedProviders);
	}
	cachedSearchConfig = {
		searchProvider,
		searchProviderConfigured,
		...(searchRouting ? { searchRouting } : {}),
		...(searchModel ? { searchModel } : {}),
		...(allowedProviders ? { allowedProviders } : {}),
	};
	return cachedSearchConfig;
}

function normalizeSearchRouting(value: unknown): SearchRoutingConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`searchRouting in ${CONFIG_PATH} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	const providers = normalizeResolvedProviderList(raw.providers, `searchRouting.providers in ${CONFIG_PATH}`);
	const useCurrentModel = raw.useCurrentModel;
	if (useCurrentModel !== undefined && typeof useCurrentModel !== "boolean") {
		throw new Error(`searchRouting.useCurrentModel in ${CONFIG_PATH} must be a boolean`);
	}
	if (!Array.isArray(raw.fallbackOn) || raw.fallbackOn.length === 0) {
		throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} must be a non-empty array`);
	}
	const fallbackOn: SearchRoutingConfig["fallbackOn"] = [];
	for (const kind of raw.fallbackOn) {
		if (typeof kind !== "string" || !VALID_ROUTING_KINDS.includes(kind as typeof VALID_ROUTING_KINDS[number])) {
			throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} may only contain transient, quota, network, invalid-response, unsupported, empty, domain-miss, or off-topic`);
		}
		if (!fallbackOn.includes(kind as SearchRoutingConfig["fallbackOn"][number])) {
			fallbackOn.push(kind as SearchRoutingConfig["fallbackOn"][number]);
		}
	}
	const timeoutMs = raw.timeoutMs;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_ROUTING_TIMEOUT_MS)) {
		throw new Error(`searchRouting.timeoutMs in ${CONFIG_PATH} must be an integer from 1 through ${MAX_ROUTING_TIMEOUT_MS}`);
	}
	const offTopicModel = raw.offTopicModel;
	if (offTopicModel !== undefined && (typeof offTopicModel !== "string" || !Object.hasOwn(OFFTOPIC_JUDGE_MODELS, offTopicModel))) {
		throw new Error(`searchRouting.offTopicModel in ${CONFIG_PATH} must be one of ${Object.keys(OFFTOPIC_JUDGE_MODELS).join(", ")}`);
	}
	if (fallbackOn.includes("off-topic") && offTopicModel === undefined) {
		throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} lists off-topic, which needs searchRouting.offTopicModel`);
	}
	return {
		providers,
		...(useCurrentModel !== undefined ? { useCurrentModel: useCurrentModel as boolean } : {}),
		fallbackOn,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(offTopicModel !== undefined ? { offTopicModel: offTopicModel as OffTopicJudgeModel } : {}),
	};
}

export function getConfiguredSearchRouting(): SearchRoutingConfig | undefined {
	const config = getSearchConfig();
	return config.searchProviderConfigured ? undefined : config.searchRouting;
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeResolvedProviderList(value: unknown, label: string): ResolvedSearchProvider[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}
	const providers: ResolvedSearchProvider[] = [];
	for (const provider of value) {
		const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
		if (!RESOLVED_SEARCH_PROVIDERS.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} contains an invalid provider: ${String(provider)}`);
		}
		if (providers.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`${label} must not contain duplicates: ${normalized}`);
		}
		providers.push(normalized as ResolvedSearchProvider);
	}
	return providers;
}

export function assertSearchProviderSelectionAllowed(
	selection: SearchProviderSelection,
	label = "provider",
	allowedProviders = getSearchConfig().allowedProviders,
): void {
	if (!allowedProviders) return;
	const requested = Array.isArray(selection)
		? selection
		: selection === "auto" || selection === "all" ? [] : [selection];
	const disabled = requested.filter(provider => !allowedProviders.includes(provider));
	if (disabled.length > 0) {
		throw new Error(`${label} ${disabled.length === 1 ? `references disabled provider "${disabled[0]}"` : `references disabled providers: ${disabled.join(", ")}`}; allowed by webSearch.allowedProviders: ${allowedProviders.join(", ")}`);
	}
}

export function getAllowedSearchProviders(): readonly ResolvedSearchProvider[] {
	return getSearchConfig().allowedProviders ?? RESOLVED_SEARCH_PROVIDERS;
}

export function normalizeSearchProviderSelection(value: unknown, label = "provider"): SearchProviderSelection {
	if (Array.isArray(value)) return normalizeResolvedProviderList(value, label);
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return SEARCH_PROVIDERS.includes(normalized as SearchProvider) ? normalized as SearchProvider : "auto";
}

/** Strict parser for tool-call `provider` arguments; config values keep the lenient normalizer. */
export function parseProviderArgument(value: unknown): SearchProviderSelection | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return normalizeResolvedProviderList(value, "provider");
	const unknown = (name: string) => new Error(`Unknown search provider "${name}". Use auto, all, or one or more comma-separated names: ${getAllowedSearchProviders().join(", ")}`);
	if (typeof value !== "string") throw unknown(String(value));
	const normalized = value.trim().toLowerCase();
	if (normalized === "") return undefined;
	let names: string[];
	if (normalized.startsWith("[")) {
		let parsed: unknown[];
		try {
			parsed = JSON.parse(normalized);
		} catch {
			throw new Error("provider must be a provider name or comma-separated names; the given value is not valid JSON");
		}
		names = parsed.map(entry => String(entry).trim());
	} else {
		names = normalized.split(",").map(name => name.trim()).filter(Boolean);
		if (names.length < 2) {
			if (!SEARCH_PROVIDERS.includes(names[0] as SearchProvider)) throw unknown(names[0] ?? value);
			return names[0] as SearchProvider;
		}
	}
	if (names.some(name => name === "auto" || name === "all")) {
		throw new Error('"auto" and "all" cannot be combined with provider names');
	}
	const invalid = names.find(name => !RESOLVED_SEARCH_PROVIDERS.includes(name as ResolvedSearchProvider));
	if (invalid !== undefined) throw unknown(invalid);
	return normalizeResolvedProviderList(names, "provider");
}

/** Validate the original arguments, before config can supply an implicit provider. */
export function validateSearchModelOverride(provider: unknown, model: unknown): string | undefined {
	if (model === undefined) return undefined;
	if (typeof model !== "string" || !model.trim()) {
		throw new Error("model must be a non-empty model ID");
	}
	const selected = parseProviderArgument(provider);
	if (selected === undefined || Array.isArray(selected) || selected === "auto" || selected === "all") {
		throw new Error("model requires one explicit provider: openai, xai, mistral, or gemini (API only); omitted, auto, all, and provider lists are ambiguous");
	}
	if (!["openai", "xai", "mistral", "gemini"].includes(selected)) {
		throw new Error(`model is not supported for provider ${JSON.stringify(selected)}; use openai, xai, mistral, or gemini (API only)`);
	}
	assertSearchProviderSelectionAllowed(selected, "Requested provider");
	return model.trim();
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProviderSelection;
	/** The caller already substituted the configured default for an omitted or "auto" provider. */
	providerFromConfig?: boolean;
	includeContent?: boolean;
	extensionContext?: ExtensionContext;
	/** Forwarded to providers that understand it (currently Exa); ignored elsewhere. */
	category?: string;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

type TakeAutoResult = (result: SearchResponse | null, provider: ResolvedSearchProvider) => AttributedSearchResponse | null;

async function tryOpenAIInAuto(query: string, options: FullSearchOptions, fallbackErrors: string[], take: TakeAutoResult): Promise<AttributedSearchResponse | null> {
	try {
		if (await isOpenAISearchAvailable(options.extensionContext)) {
			const result = await searchWithOpenAI(query, options, options.extensionContext);
			return take(result, "openai");
		}
	} catch (err) {
		if (isAbortError(err)) throw err;
		fallbackErrors.push(`OpenAI: ${errorMessage(err)}`);
	}
	return null;
}

async function searchWithGemini(
	query: string,
	options: SearchOptions,
	strictErrors: boolean,
): Promise<SearchResponse | null> {
	// Gemini Web cannot honor an explicit model, so never fall back to it.
	if (options.model !== undefined) {
		const result = await searchWithGeminiApi(query, options);
		if (result) return result;
		throw new Error("Gemini API search unavailable: an explicit model requires API-path authentication (API key, ADC, or gateway), not browser cookies");
	}
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options);
		if (apiResult) return apiResult;
	} catch (err) {
		if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
		errors.push(`Gemini API: ${errorMessage(err)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options);
		if (webResult) return webResult;
		const diagnostic = getGeminiWebAvailabilityDiagnostic();
		if (diagnostic) errors.push(`Gemini Web: ${diagnostic}`);
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini Web: ${errorMessage(err)}`);
	}

	if (strictErrors && errors.length > 0) {
		throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`);
	}

	return null;
}

function providerErrorStatus(message: string): number | undefined {
	const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
	if (!match) return undefined;
	return Number(match[1]);
}

function classifyProviderError(provider: ResolvedSearchProvider, err: unknown): SearchProviderError {
	if (err instanceof SearchProviderError) return err;
	const message = errorMessage(err);
	const lower = message.toLowerCase();
	const status = providerErrorStatus(message);
	// An HTTP 200 OpenAI stream reports its failure as an error type/code such as
	// rate_limit_exceeded or server_error. Reading only that message with spaces
	// lets the shared keywords below classify it like prose, without widening them
	// for other providers, which echo foreign text (Bright Data zone names,
	// envelope codes) that must keep classifying as before. OpenAI error types
	// the shared keywords don't name (usage limit, authentication_error,
	// permission_error, invalid_api_key, api_error, internal_error, overloaded)
	// are added per branch for these messages only.
	const openAIStreamError = provider === "openai" && lower.includes("openai api stream error");
	const text = openAIStreamError ? lower.replace(/_/g, " ") : lower;
	let kind: SearchProviderErrorKind = "unknown";
	const mentionsUnsupportedWebSearch = /(?:web[_ -]?search|web[_ -]?search_preview|(?:the )?tool)\b.*\b(?:unsupported|not supported|does not support|doesn't support|unknown|unrecognized|unavailable|not found)|\b(?:unsupported|not supported|does not support|doesn't support|unknown|unrecognized|unavailable|not found)\b.*\b(?:web[_ -]?search|web[_ -]?search_preview|(?:the )?tool)/i.test(lower);
	if (err instanceof CredentialResolutionError || /(?:api )?key (?:not found|missing)|credential resolution/.test(lower)) {
		kind = "credential";
	} else if (isAbortError(err)) {
		kind = "aborted";
	} else if (err instanceof OpenAIAlphaSearchUnsupportedError) {
		kind = "unsupported";
	} else if (provider === "xai" && status === 403 && /spending[- ]limit|(?:no|out of) credits?|insufficient quota|quota (?:exceeded|exhausted)|credits? (?:exhausted|depleted|used up)/.test(lower)) {
		kind = "quota";
	} else if (status === 401 || status === 403) {
		kind = "auth";
	} else if (provider === "openai" && (status === 400 || status === 422) && mentionsUnsupportedWebSearch) {
		kind = "unsupported";
	} else if (status === 400 || status === 422) {
		kind = "invalid-request";
	} else if (status === 402 || status === 429 || (provider === "tavily" && status === 432)) {
		kind = "quota";
	} else if (status !== undefined && (status === 408 || status === 425 || status >= 500)) {
		kind = "transient";
	} else if (/rate limit|quota|too many requests/.test(text) || (openAIStreamError && /usage limit/.test(text))) {
		kind = "quota";
	} else if (/unauthorized|forbidden|permission denied/.test(text) || (openAIStreamError && /authentication error|permission error|invalid api key/.test(text))) {
		kind = "auth";
	} else if (/bad request|invalid request/.test(text)) {
		kind = "invalid-request";
	} else if (/invalid json|no parseable response|no parseable results|invalid response|returned empty response|no web_search_call/.test(text)) {
		kind = "invalid-response";
	} else if (/temporar|service unavailable|server error/.test(text) || (openAIStreamError && /internal error|\bapi error|overloaded/.test(text))) {
		kind = "transient";
	} else if (err instanceof TypeError || /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(text)) {
		kind = "network";
	} else if (/invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(text)) {
		kind = "config";
	} else if (openAIStreamError) {
		// The same stream threw "no parseable response output" before its error was surfaced.
		kind = "invalid-response";
	}
	return new SearchProviderError(provider, kind, message, status, err);
}

async function searchWithResolvedProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
	useCurrentModel = false,
): Promise<ProviderSearchResponse> {
	if (provider === "openai") {
		const result = useCurrentModel
			? await searchWithCurrentModelOpenAI(query, options, options.extensionContext)
			: await searchWithOpenAI(query, options, options.extensionContext);
		return { ...result, provider };
	}
	if (provider === "brave") return { ...(await searchWithBrave(query, options)), provider };
	if (provider === "parallel") return { ...(await searchWithParallel(query, options)), provider };
	if (provider === "parallel-mcp") return { ...(await searchWithParallelMcp(query, options)), provider };
	if (provider === "tinyfish") return { ...(await searchWithTinyFish(query, options)), provider };
	if (provider === "search1api") return { ...(await searchWithSearch1API(query, options)), provider };
	if (provider === "searchinfinity") return { ...(await searchWithSearchinfinity(query, options)), provider };
	if (provider === "querit") return { ...(await searchWithQuerit(query, options)), provider };
	if (provider === "tavily") return { ...(await searchWithTavily(query, options)), provider };
	if (provider === "you") return { ...(await searchWithYou(query, options)), provider };
	if (provider === "firecrawl") return { ...(await searchWithFirecrawl(query, options)), provider };
	if (provider === "jina") return { ...(await searchWithJina(query, options)), provider };
	if (provider === "serpdive") return { ...(await searchWithSerpdive(query, options)), provider };
	if (provider === "kagi") return { ...(await searchWithKagi(query, options)), provider };
	if (provider === "bocha") return { ...(await searchWithBocha(query, options)), provider };
	if (provider === "ollama") return { ...(await searchWithOllama(query, options)), provider };
	if (provider === "anysearch") return { ...(await searchWithAnySearch(query, options)), provider };
	if (provider === "xai") return { ...(await searchWithXai(query, options, options.extensionContext)), provider };
	if (provider === "mistral") return { ...(await searchWithMistral(query, options)), provider };
	if (provider === "brightdata") return { ...(await searchWithBrightData(query, options)), provider };
	if (provider === "serpbase") return { ...(await searchWithSerpBase(query, options)), provider };
	if (provider === "serpapi") return { ...(await searchWithSerpApi(query, options)), provider };
	if (provider === "serper") return { ...(await searchWithSerper(query, options)), provider };
	if (provider === "serply") return { ...(await searchWithSerply(query, options)), provider };
	if (provider === "baizhi") return { ...(await searchWithBaizhi(query, options)), provider };
	if (provider === "zai") return { ...(await searchWithZai(query, options)), provider };
	if (provider === "valyu") return { ...(await searchWithValyu(query, options)), provider };
	if (provider === "keenable") return { ...(await searchWithKeenable(query, options)), provider };
	if (provider === "ceramic") return { ...(await searchWithCeramic(query, options)), provider };
	if (provider === "linkup") return { ...(await searchWithLinkup(query, options)), provider };
	if (provider === "ninerouter") return { ...(await searchWithNineRouter(query, options)), provider };
	if (provider === "deepseek") return { ...(await searchWithDeepSeek(query, options)), provider };
	if (provider === "xcrawl") return { ...(await searchWithXCrawl(query, options)), provider };
	if (provider === "perplexity") return { ...(await searchWithPerplexity(query, options)), provider };
	if (provider === "searxng") return { ...(await searchWithSearXNG(query, options)), provider };
	if (provider === "degoog") return { ...(await searchWithDegoog(query, options)), provider };
	if (provider === "duckduckgo") return { ...(await searchWithDuckDuckGo(query, options)), provider };
	if (provider === "kimi") return { ...(await searchWithKimi(query, options, options.extensionContext)), provider };
	if (provider === "gemini") {
		const result = await searchWithGemini(query, options, true);
		if (result) return { ...result, provider };
		throw new Error(
			"Gemini search unavailable. Either:\n" +
			`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
			"  3. Set geminiAuth to \"adc\" in web-search.json with a Google Cloud ADC + project/location\n" +
			"  4. Sign into gemini.google.com in a supported Chromium-based browser",
		);
	}
	const result = await searchWithExa(query, options);
	if (result) return { ...result, provider };
	throw new Error("Exa search returned no results.");
}

async function isResolvedProviderAvailable(provider: ResolvedSearchProvider, options: FullSearchOptions, useCurrentModel = false): Promise<boolean> {
	if (provider === "openai") {
		return useCurrentModel
			? isCurrentModelHostedSearchEligible(options.extensionContext)
			: isOpenAISearchAvailable(options.extensionContext);
	}
	if (provider === "brave") return isBraveAvailable();
	if (provider === "parallel") return isParallelAvailable();
	if (provider === "parallel-mcp") return isParallelMcpAvailable();
	if (provider === "tinyfish") return isTinyFishAvailable();
	if (provider === "search1api") return isSearch1APIAvailable();
	if (provider === "searchinfinity") return isSearchinfinityAvailable();
	if (provider === "querit") return isQueritAvailable();
	if (provider === "tavily") return isTavilyAvailable();
	if (provider === "you") return isYouAvailable();
	if (provider === "firecrawl") return isFirecrawlAvailable();
	if (provider === "jina") return isJinaSearchAvailable();
	if (provider === "serpdive") return isSerpdiveAvailable();
	if (provider === "kagi") return isKagiAvailable();
	if (provider === "bocha") return isBochaAvailable();
	if (provider === "ollama") return isOllamaAvailable();
	if (provider === "anysearch") return isAnySearchAvailable();
	if (provider === "xai") return isXaiSearchAvailable(options.extensionContext);
	if (provider === "mistral") return isMistralAvailable();
	if (provider === "brightdata") return isBrightDataAvailable();
	if (provider === "serpbase") return isSerpBaseAvailable();
	if (provider === "serpapi") return isSerpApiAvailable();
	if (provider === "serper") return isSerperAvailable();
	if (provider === "serply") return isSerplyAvailable();
	if (provider === "baizhi") return isBaizhiAvailable();
	if (provider === "zai") return isZaiAvailable();
	if (provider === "valyu") return isValyuAvailable();
	if (provider === "keenable") return isKeenableAvailable();
	if (provider === "ceramic") return isCeramicAvailable();
	if (provider === "linkup") return isLinkupAvailable();
	if (provider === "ninerouter") return isNineRouterAvailable();
	if (provider === "deepseek") return isDeepSeekAvailable();
	if (provider === "xcrawl") return isXcrawlAvailable();
	if (provider === "perplexity") return isPerplexityAvailable();
	if (provider === "searxng") return isSearXNGAvailable();
	if (provider === "degoog") return isDegoogAvailable();
	if (provider === "duckduckgo") return isDuckDuckGoAvailable();
	if (provider === "gemini") return isGeminiApiAvailable() || await isGeminiWebOptionallyAvailable();
	if (provider === "kimi") return isKimiSearchAvailable(options.extensionContext);
	return isExaAvailable();
}

async function isGeminiWebOptionallyAvailable(): Promise<boolean> {
	try {
		return !!(await isGeminiWebAvailable());
	} catch {
		return false;
	}
}

export function providerLabel(provider: ResolvedSearchProvider): string {
	if (provider === "openai") return "OpenAI";
	if (provider === "parallel-mcp") return "Parallel MCP";
	if (provider === "tinyfish") return "TinyFish";
	if (provider === "search1api") return "Search1API";
	if (provider === "searchinfinity") return "Searchinfinity";
	if (provider === "querit") return "Querit";
	if (provider === "firecrawl") return "Firecrawl";
	if (provider === "serpdive") return "SERPdive";
	if (provider === "searxng") return "SearXNG";
	if (provider === "degoog") return "degoog";
	if (provider === "duckduckgo") return "DuckDuckGo";
	if (provider === "kagi") return "Kagi";
	if (provider === "bocha") return "Bocha";
	if (provider === "xcrawl") return "XCrawl";
	if (provider === "kimi") return "Kimi";
	if (provider === "ollama") return "Ollama";
	if (provider === "xai") return "xAI";
	if (provider === "mistral") return "Mistral";
	if (provider === "brightdata") return "Bright Data";
	if (provider === "serpbase") return "SerpBase";
	if (provider === "serpapi") return "SerpApi";
	if (provider === "serper") return "Serper";
	if (provider === "serply") return "Serply";
	if (provider === "you") return "You.com";
	if (provider === "baizhi") return "Baizhi";
	if (provider === "zai") return "Z.ai";
	if (provider === "valyu") return "Valyu";
	if (provider === "keenable") return "Keenable";
	if (provider === "ceramic") return "Ceramic";
	if (provider === "linkup") return "Linkup";
	if (provider === "ninerouter") return "9router";
	if (provider === "deepseek") return "DeepSeek";
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

async function searchWithAllProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Promise<ProviderSearchResponse> {
	if (provider !== "gemini") return searchWithResolvedProvider(provider, query, options);
	const result = await searchWithGeminiApi(query, options);
	if (result) return { ...result, provider };
	throw new Error("Gemini API search returned no results.");
}

async function searchWithProviders(
	query: string,
	options: FullSearchOptions,
	selectedProviders?: ResolvedSearchProvider[],
	routing?: SearchRoutingConfig,
): Promise<AttributedSearchResponse> {
	const allowed = getAllowedSearchProviders();
	const providers = selectedProviders ?? (await Promise.all(ALL_SEARCH_PROVIDERS.filter(provider => allowed.includes(provider)).map(async (provider) => ({
		provider,
		available: provider === "gemini"
			? isGeminiApiAvailable()
			: await isResolvedProviderAvailable(provider, options),
	})))).filter((entry) => entry.available).map((entry) => entry.provider);
	if (providers.length === 0) {
		throw new Error("No configured search provider available for provider \"all\". Parallel MCP, degoog, DuckDuckGo, Kimi, AnySearch, xAI, Mistral, Bright Data, SerpBase, SerpApi, Serper, Serply, You.com, Valyu, Baizhi, Z.ai, XCrawl, Keenable, Ceramic, DeepSeek, Linkup, and 9router are excluded.");
	}

	const settled = await Promise.allSettled(
		providers.map((provider) => selectedProviders
			? searchWithResolvedProvider(provider, query, options)
			: searchWithAllProvider(provider, query, options)),
	);
	if (options.signal?.aborted) throw new Error("Aborted");

	const successes: ProviderSearchResponse[] = [];
	const failures: Array<{ provider: ResolvedSearchProvider; error: string }> = [];
	for (let index = 0; index < settled.length; index++) {
		const outcome = settled[index];
		if (outcome.status === "fulfilled") {
			successes.push(outcome.value);
		} else {
			failures.push({ provider: providers[index], error: errorMessage(outcome.reason) });
		}
	}
	if (successes.length === 0) {
		const label = selectedProviders ? "Selected-provider" : "All-provider";
		const failureMessage = `${label} search failed:\n  - ${failures.map(({ provider, error }) => `${providerLabel(provider)}: ${error}`).join("\n  - ")}`;
		// Routing continues only when every array failure is a kind it would itself fall back on.
		if (!routing || !settled.every((outcome, index) => outcome.status === "rejected" &&
			routing.fallbackOn.includes(classifyProviderError(providers[index], outcome.reason).kind as SearchRoutingConfig["fallbackOn"][number]))) {
			throw new Error(failureMessage);
		}
		const untried = routing.providers.filter((provider) => !providers.includes(provider));
		try {
			if (untried.length === 0) throw new Error("Configured search routing has no untried providers");
			return await searchWithConfiguredRouting(query, options, { ...routing, providers: untried });
		} catch (err) {
			if (isAbortError(err)) throw err;
			throw new Error(`${failureMessage}\n${errorMessage(err)}`);
		}
	}

	const results: SearchResult[] = [];
	const seenResultUrls = new Set<string>();
	const inlineContent: NonNullable<SearchResponse["inlineContent"]> = [];
	const seenInlineUrls = new Set<string>();
	for (const response of successes) {
		for (const result of response.results) {
			if (seenResultUrls.has(result.url)) continue;
			seenResultUrls.add(result.url);
			results.push(result);
		}
		for (const content of response.inlineContent ?? []) {
			if (seenInlineUrls.has(content.url)) continue;
			seenInlineUrls.add(content.url);
			inlineContent.push(content);
		}
	}

	const answerSections = successes.map((response) =>
		`## ${providerLabel(response.provider)}\n\n${response.answer || "(No answer text returned.)"}`
	);
	if (failures.length > 0) {
		answerSections.push(
			`## Provider errors\n\n${failures.map(({ provider, error }) => `- **${providerLabel(provider)}:** ${error}`).join("\n")}`,
		);
	}

	return {
		provider: "all",
		answer: answerSections.join("\n\n"),
		results,
		providerResponses: successes,
		...(failures.length > 0 ? { providerErrors: failures } : {}),
		...(inlineContent.length > 0 ? { inlineContent } : {}),
	};
}

/** A successful response a route may still move past: no results and no answer (`empty`), or no result on a requested domain (`domain-miss`). */
function weakResult(response: SearchResponse, domainFilter: string[] | undefined): { empty: boolean; domainMiss: boolean } {
	const empty = response.results.length === 0 && !response.answer.trim();
	const wanted = (domainFilter ?? [])
		.filter((domain) => !domain.trim().startsWith("-"))
		.flatMap((domain) => normalizeDomain(domain) ?? []);
	const domainMiss = wanted.length > 0 && !response.results.some((result) => {
		const host = URL.parse(result.url)?.hostname;
		return host !== undefined && wanted.some((domain) => host === domain || host.endsWith(`.${domain}`));
	});
	return { empty, domainMiss };
}

async function searchWithConfiguredRouting(
	query: string,
	callerOptions: FullSearchOptions,
	routing: SearchRoutingConfig,
): Promise<AttributedSearchResponse> {
	const deadline = routing.timeoutMs ? AbortSignal.timeout(routing.timeoutMs) : undefined;
	const signal = deadline && (callerOptions.signal ? AbortSignal.any([callerOptions.signal, deadline]) : deadline);
	const options: FullSearchOptions = signal ? { ...callerOptions, signal } : callerOptions;
	const timedOut = () => deadline?.aborted === true && callerOptions.signal?.aborted !== true;
	// Availability checks, Pi auth, and cookie scans ignore the signal, so race each step against it (caller abort or deadline); abandoned work finishes in the background and is ignored.
	const untilDeadline = <T>(work: Promise<T>): Promise<T> => awaitWithAbort(work, signal);
	const diagnostics: string[] = [];
	let firstWeak: AttributedSearchResponse | undefined;
	for (const provider of routing.providers) {
		if (timedOut()) {
			diagnostics.push(`routing timeout after ${routing.timeoutMs}ms`);
			break;
		}
		const useCurrentModel = provider === "openai" && routing.useCurrentModel === true;
		const available = await untilDeadline(isResolvedProviderAvailable(provider, options, useCurrentModel)).catch((err) => {
			if (timedOut()) return undefined;
			throw err;
		});
		if (available === undefined) {
			diagnostics.push(`${provider}: routing timeout after ${routing.timeoutMs}ms`);
			break;
		}
		if (!available) {
			diagnostics.push(`${provider}: unavailable`);
			continue;
		}
		try {
			const response = await untilDeadline(searchWithResolvedProvider(provider, query, options, useCurrentModel));
			const weak = weakResult(response, options.domainFilter);
			let kind = weak.empty && routing.fallbackOn.includes("empty") ? "empty" : weak.domainMiss && routing.fallbackOn.includes("domain-miss") ? "domain-miss" : undefined;
			// Over MCP there is no Pi model registry, so the off-topic check is inactive there.
			const registry = options.extensionContext?.modelRegistry;
			if (!kind && !weak.empty && routing.offTopicModel && routing.fallbackOn.includes("off-topic") && registry) {
				// A deadline during the check keeps the response: it is still a success.
				const judgment = await untilDeadline(judgeOffTopic(routing.offTopicModel, query, response, registry, options.signal))
					.catch((err) => { if (timedOut()) return { error: `routing timeout after ${routing.timeoutMs}ms` }; throw err; });
				if ("error" in judgment) {
					const line = `${provider}: off-topic check failed: ${judgment.error}`;
					diagnostics.push(line);
					activityMonitor.logError(activityMonitor.logStart({ type: "api", query }), line);
				} else if (judgment.probabilities.off_topic >= OFFTOPIC_JUDGE_MODELS[routing.offTopicModel]) kind = "off-topic";
			}
			if (!kind) return response;
			diagnostics.push(`${provider} [${kind}]`);
			firstWeak ??= response;
		} catch (err) {
			if (timedOut()) {
				diagnostics.push(`${provider}: routing timeout after ${routing.timeoutMs}ms`);
				break;
			}
			const classified = classifyProviderError(provider, err);
			diagnostics.push(`${provider} [${classified.kind}]: ${errorMessage(err)}`);
			if (!routing.fallbackOn.includes(classified.kind as SearchRoutingConfig["fallbackOn"][number])) {
				throw classified;
			}
		}
	}
	// Like the built-in auto chain, hand back the first weak response rather than an error.
	if (firstWeak) return firstWeak;
	throw new Error(`Configured search routing exhausted:\n  - ${diagnostics.join("\n  - ")}`);
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider === undefined || options.provider === "auto"
		? config.searchProvider
		: options.provider;
	assertSearchProviderSelectionAllowed(provider, "Requested provider");
	if (Array.isArray(provider)) {
		// Only a config-default array falls back to searchRouting; a per-call array stays strict.
		const fromConfig = options.providerFromConfig === true || options.provider === undefined || options.provider === "auto";
		const routing = fromConfig ? config.searchRouting : undefined;
		return searchWithProviders(query, options, normalizeResolvedProviderList(provider, "provider"), routing);
	}
	if (provider === "all") return searchWithProviders(query, options);
	if (provider !== "auto") return searchWithResolvedProvider(provider, query, options);
	if (!config.searchProviderConfigured && config.searchRouting) {
		return searchWithConfiguredRouting(query, options, config.searchRouting);
	}

	const fallbackErrors: string[] = [];
	// An empty 200 keeps the chain going; if every provider is empty, return the first.
	let firstEmpty: AttributedSearchResponse | undefined;
	const take: TakeAutoResult = (result, provider) => {
		if (!result) return null;
		const response = { ...result, provider };
		if (result.results.length || result.answer.trim()) return response;
		firstEmpty ??= response;
		return null;
	};
	const allowed = new Set(config.allowedProviders ?? RESOLVED_SEARCH_PROVIDERS);
	const attempt = async (provider: ResolvedSearchProvider): Promise<AttributedSearchResponse | null> => {
		if (!allowed.has(provider) || !(await isResolvedProviderAvailable(provider, options))) return null;
		try {
			return take(await searchWithResolvedProvider(provider, query, options), provider);
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`${providerLabel(provider)}: ${errorMessage(err)}`);
			return null;
		}
	};

	const searxng = await attempt("searxng");
	if (searxng) return searxng;

	let triedOpenAI = false;
	if (allowed.has("openai") && (!options.extensionContext || isOpenAISubscriptionModelSelected(options.extensionContext))) {
		triedOpenAI = true;
		const result = await tryOpenAIInAuto(query, options, fallbackErrors, take);
		if (result) return result;
	}

	if (allowed.has("exa") && isExaAvailable()) {
		try {
			const response = take(await searchWithExa(query, options), "exa");
			if (response) return response;
		} catch (err) {
			if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
			fallbackErrors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	if (allowed.has("openai") && !triedOpenAI) {
		const result = await tryOpenAIInAuto(query, options, fallbackErrors, take);
		if (result) return result;
	}

	for (const provider of ["brave", "parallel", "tinyfish", "search1api", "searchinfinity", "querit", "tavily", "firecrawl", "jina", "serpdive", "kagi", "bocha", "ollama", "perplexity"] as const) {
		const response = await attempt(provider);
		if (response) return response;
	}

	if (allowed.has("gemini")) try {
		const response = take(await searchWithGemini(query, options, false), "gemini");
		if (response) return response;
	} catch (err) {
		if (isAbortError(err)) throw err;
		fallbackErrors.push(`Gemini: ${errorMessage(err)}`);
	}

	if (firstEmpty) return firstEmpty;
	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
		"  1. Use /login to sign in with a Codex subscription for OpenAI web search\n" +
		`  2. Set openaiApiKey, braveApiKey, parallelApiKey, tinyfishApiKey, search1apiApiKey, searchinfinityApiKey, queritApiKey, tavilyApiKey, firecrawlBaseUrl, jinaApiKey, serpdiveApiKey, kagiApiKey, ollamaApiKey, searxngBaseUrl, perplexityApiKey, exaApiKey, geminiApiKey, bochaApiKey, or cloudflareApiKey in ${CONFIG_PATH}\n` +
		"  3. Set OPENAI_API_KEY, BRAVE_API_KEY, PARALLEL_API_KEY, TINYFISH_API_KEY, SEARCH1API_KEY, SEARCHINFINITY_API_KEY, QUERIT_API_KEY, TAVILY_API_KEY, FIRECRAWL_BASE_URL, JINA_API_KEY, SERPDIVE_API_KEY, KAGI_API_KEY, BOCHA_API_KEY, OLLAMA_API_KEY, SEARXNG_BASE_URL, EXA_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, or CLOUDFLARE_API_KEY env vars\n" +
		"  4. Set GOOGLE_GEMINI_BASE_URL with CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
		"  5. Sign into gemini.google.com in a supported Chromium-based browser\n" +
		"  6. Explicitly select provider: \"anysearch\" for anonymous AnySearch, \"xcrawl\" for XCrawl, \"xai\" for Grok, \"mistral\" for Mistral Conversations web search, \"brightdata\" with brightdataSerpZone for paid Bright Data SERP, \"serpbase\", \"serpapi\", \"serper\", or \"serply\" for Google SERP, \"you\" for You.com, \"zai\" for Z.ai GLM Coding Plan search, \"valyu\" for research search, \"keenable\" for keyless Keenable search, \"ceramic\" for Ceramic search, \"deepseek\" for DeepSeek search, \"linkup\" for Linkup search, or \"ninerouter\" for a 9router gateway"
	);
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const requestSignal = AbortSignal.any([
		AbortSignal.timeout(120000),
		...(options.signal ? [options.signal] : []),
	]);
	const apiKey = isGeminiAdcAvailable() ? null : await getApiKey(requestSignal);
	if (!apiKey && !isGatewayConfigured() && !isGeminiAdcAvailable()) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = options.model ?? getSearchConfig().searchModel ?? DEFAULT_SEARCH_MODEL;
		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetchGeminiApi(`${getVersionedApiBase()}/models/${options.model !== undefined ? encodeURIComponent(model) : model}:generateContent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal,
		}, apiKey);

		if (!res.ok) {
			const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) {
			if (options.model !== undefined) throw new Error("Gemini API returned no answer or sources");
			return null;
		}
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			signal: options.signal,
			timeoutMs: 120000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}
	return results;
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(5000),
				...(signal ? [signal] : []),
			]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
