// Host-neutral execution core for web_search (non-curator path), fetch_content,
// get_search_content, and source_check. The Pi extension (index.ts) and the MCP
// server both run tools through createWebToolCore; everything that differs per
// host (session persistence, background notifications, Pi model access) is a
// WebToolCoreHost hook. This module must stay free of runtime imports from
// index.ts, curator/summary/activation modules, and @earendil-works/* packages.
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import pLimit from "p-limit";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { normalizeFetchContentParams, type FetchContentParams } from "./fetch-params.ts";
import { resolveAuthFetchProfile, type AuthFetchProfile } from "./auth-fetch.ts";
import { findContent, type FindMode } from "./content-find.ts";
import {
	assertSearchProviderSelectionAllowed,
	normalizeSearchProviderSelection,
	search,
	type SearchProvider,
	type SearchProviderSelection,
} from "./gemini-search.ts";
import { isOpenAISearchAvailable } from "./openai-search.ts";
import type { SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath, runWithProxy } from "./utils.ts";
import { deleteResult, generateId, getResult, storeResult, type QueryResultData, type StoredSearchData } from "./storage.ts";
import {
	buildResearchArtifact,
	getResearchArtifact,
	storeResearchArtifact,
	withClaimAssessment,
	type RecencyFilter,
	type ResearchArtifact,
} from "./source-check.ts";
import type { SummaryMeta } from "./summary-review.ts";
import type {
	FetchContentCallParams,
	GetSearchContentCallParams,
	SourceCheckCallParams,
	WebSearchCallParams,
	WebToolContent,
	WebToolCore,
	WebToolResult,
} from "./web-tool-contract.ts";

export const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

export interface WebSearchConfig {
	anysearchApiKey?: unknown;
	xcrawlApiKey?: unknown;
	brightdataApiKey?: unknown;
	brightdataSerpZone?: unknown;
	kagiApiKey?: unknown;
	ollamaApiKey?: unknown;
	serpbaseApiKey?: unknown;
	serpapiApiKey?: unknown;
	serperApiKey?: unknown;
	serplyApiKey?: unknown;
	youApiKey?: unknown;
	baizhiApiKey?: unknown;
	zaiApiKey?: unknown;
	tinyfishApiKey?: unknown;
	valyuApiKey?: unknown;
	keenableApiKey?: unknown;
	degoogBaseUrl?: unknown;
	degoogApiKey?: unknown;
	degoogEngines?: unknown;
	degoogHeaders?: unknown;
	xaiApiKey?: unknown;
	provider?: unknown;
	searchProvider?: unknown;
	workflow?: string;
	curatorTimeoutSeconds?: unknown;
	autoOpenBrowser?: unknown;
	curatorRemote?: unknown;
	summaryModel?: string;
	summaryGenerationDeadlineMs?: unknown;
	summaryInstructions?: unknown;
	maxInlineContentChars?: unknown;
	fetch?: {
		defaultMode?: unknown;
		allowedModes?: unknown;
	};
	webSearch?: {
		enabled?: boolean;
		allowedProviders?: unknown;
	};
	tools?: Partial<Record<keyof ToolNames, { enabled?: boolean }>>;
	toolActivation?: unknown;
	commands?: Partial<Record<"websearch" | "curator" | "search" | "google-account", { enabled?: boolean }>>;
	toolNames?: Partial<ToolNames>;
	shortcuts?: {
		curate?: KeyId;
		activity?: KeyId;
	};
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
		/** Skip local hostname DNS preflight when an HTTP(S)_PROXY env var applies. */
		trustEnvProxy?: boolean;
	};
}

export function parseConfigRoot(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${WEB_SEARCH_CONFIG_PATH}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

export function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	return parseConfigRoot(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8")) as WebSearchConfig;
}

export type ToolNames = {
	webSearch: string;
	sourceCheck: string;
	fetchContent: string;
	getSearchContent: string;
};

export const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	sourceCheck: "source_check",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
};
const SEARCH_QUERY_CONCURRENCY = 3;
const FETCH_MODES = ["readable", "raw", "answer"] as const;
export type FetchMode = typeof FETCH_MODES[number];
export type FetchModeConfig = { defaultMode: FetchMode; allowedModes: FetchMode[] };

export function resolveFetchModeConfig(config: WebSearchConfig): FetchModeConfig {
	const configuredModes = config.fetch?.allowedModes ?? FETCH_MODES;
	if (!Array.isArray(configuredModes) || configuredModes.length === 0 || configuredModes.some(mode => !FETCH_MODES.includes(mode as FetchMode))) {
		throw new Error(`fetch.allowedModes in ${WEB_SEARCH_CONFIG_PATH} must be a non-empty array containing only "readable", "raw", or "answer"`);
	}
	const allowedModes = configuredModes as FetchMode[];
	const duplicateMode = allowedModes.find((mode, index) => allowedModes.indexOf(mode) !== index);
	if (duplicateMode) {
		throw new Error(`fetch.allowedModes in ${WEB_SEARCH_CONFIG_PATH} must not contain duplicates: "${duplicateMode}"`);
	}
	const defaultMode = config.fetch?.defaultMode ?? "readable";
	if (!allowedModes.includes(defaultMode as FetchMode)) {
		throw new Error(`fetch.defaultMode in ${WEB_SEARCH_CONFIG_PATH} must be one of fetch.allowedModes`);
	}
	return { defaultMode: defaultMode as FetchMode, allowedModes };
}

// Limit each batch independently so separate Pi tool calls can still run in parallel.
export function runSearchQueries<T>(queries: string[], run: (query: string, index: number) => Promise<T>): Promise<T[]> {
	const limit = pLimit(SEARCH_QUERY_CONCURRENCY);
	return Promise.all(queries.map((query, index) => limit(() => run(query, index))));
}

export function isToolEnabled(config: WebSearchConfig, key: keyof ToolNames): boolean {
	const override = config.tools?.[key]?.enabled;
	if (typeof override === "boolean") return override;
	return key !== "webSearch" && key !== "sourceCheck" || config.webSearch?.enabled !== false;
}

function joinToolNames(names: string[]): string {
	if (names.length === 0) return "stored content";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

export function normalizeProviderInput(value: unknown, label = "provider"): SearchProviderSelection | undefined {
	if (value === undefined) return undefined;
	return normalizeSearchProviderSelection(value, label);
}

export function resolveRequestedProvider(requested: unknown): SearchProviderSelection {
	const normalizedRequested = normalizeProviderInput(requested);
	if (normalizedRequested && normalizedRequested !== "auto") {
		assertSearchProviderSelectionAllowed(normalizedRequested, "Requested provider");
		return normalizedRequested;
	}
	const config = loadConfig();
	const provider = normalizeProviderInput(config.searchProvider ?? config.provider, `provider in ${WEB_SEARCH_CONFIG_PATH}`) ?? "auto";
	assertSearchProviderSelectionAllowed(provider, `configured provider in ${WEB_SEARCH_CONFIG_PATH}`);
	return provider;
}

export function toCuratorProvider(provider: SearchProviderSelection): SearchProvider | undefined {
	if (Array.isArray(provider)) return "all";
	return provider === "auto" ? undefined : provider;
}

export function normalizeRecencyFilter(value: unknown): RecencyFilter | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year"
		? value
		: undefined;
}

export function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

// Some local models serialize a multi-query list into the single-string `query`
// field as a JSON array (query: "[\"a\", \"b\"]") instead of using the
// `queries` parameter. Forwarding that raw string verbatim makes every backend
// search for the literal array text and return zero results, with no signal to
// the model that its argument shape was wrong. Expand a string that parses as a
// JSON array of strings so each element is searched independently.
export function expandQueryString(query: unknown): string[] {
	if (typeof query !== "string") return [];
	const trimmed = query.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			// Only expand an unambiguously string-only array. Mixed or non-string
			// arrays are kept as the literal query so we never silently drop
			// members or collapse them into an empty search.
			if (Array.isArray(parsed) && parsed.every((entry): entry is string => typeof entry === "string")) {
				return parsed
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0);
			}
		} catch {
			// Not JSON — treat as a literal query string.
		}
	}
	return [query];
}

let extractModulePromise: Promise<typeof import("./extract.ts")> | undefined;
export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const extractModule = await (extractModulePromise ??= import("./extract.ts"));
	return extractModule.fetchAllContent(urls, signal, options);
}

/** Returns content for every URL in order: the provider's content where it supplied some,
 * and a page fetch only for the URLs it did not cover. */
export async function fetchUncoveredContent(
	urls: string[],
	provided: ExtractedContent[] | undefined,
	fetchPages: (urls: string[]) => Promise<ExtractedContent[]>,
): Promise<ExtractedContent[]> {
	const providedByUrl = new Map<string, ExtractedContent>();
	for (const content of provided ?? []) {
		if (!providedByUrl.has(content.url)) providedByUrl.set(content.url, content);
	}
	const missing = urls.filter(url => !providedByUrl.has(url));
	const fetched = missing.length > 0 ? await fetchPages(missing) : [];
	let next = 0;
	return urls.map(url => providedByUrl.get(url) ?? fetched[next++]);
}

export function withRegisteredFetchOptions(
	options: ExtractOptions | undefined,
	toolNames: ExtractOptions["toolNames"],
	proxy?: string,
): ExtractOptions {
	return {
		...(options ?? {}),
		toolNames,
		...(proxy !== undefined ? { proxy } : {}),
	};
}

function isAbortError(err: unknown): boolean {
	return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("abort");
}

const DEFAULT_MAX_INLINE_CONTENT_CHARS = 30_000;
const MIN_INLINE_CONTENT_CHARS = 1_000;
const MAX_INLINE_CONTENT_CHARS = 200_000;

export function getMaxInlineContentChars(config = loadConfig()): number {
	const value = config.maxInlineContentChars;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < MIN_INLINE_CONTENT_CHARS) {
		return DEFAULT_MAX_INLINE_CONTENT_CHARS;
	}
	return Math.min(value, MAX_INLINE_CONTENT_CHARS);
}

export function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail, frames, ...rest }) => rest);
}

function initialContentSlice(content: string, maxChars: number): {
	text: string;
	endOffset: number;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
} {
	let endOffset = Math.min(content.length, maxChars);
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(maxChars * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.length === 0 ? 0 : content.split("\n").length,
		shownBytes: Buffer.byteLength(text),
		shownLines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

function normalizeFindQueries(value: string | string[]): string[] {
	const queries = (Array.isArray(value) ? value : [value]).map(query => query.trim()).filter(Boolean);
	if (queries.length === 0) throw new Error("findText must contain at least one non-empty string");
	return queries;
}

type GetSearchContentParams = GetSearchContentCallParams;

export type RawGetSearchContentParams = Omit<GetSearchContentParams, "findMode"> & { findMode?: unknown };

function normalizeFindMode(value: unknown): FindMode | undefined {
	if (value === undefined) return undefined;
	if (value === "exact" || value === "case-insensitive" || value === "fuzzy") return value;
	throw new Error('findMode must be "exact", "case-insensitive", or "fuzzy"');
}

function normalizeGetSearchContentParams(params: RawGetSearchContentParams): GetSearchContentParams {
	const normalized: GetSearchContentParams = { ...params, findMode: normalizeFindMode(params.findMode) };

	if (normalized.query?.trim() === "") delete normalized.query;
	if (normalized.url?.trim() === "") delete normalized.url;

	if (normalized.findText !== undefined) {
		delete normalized.offset;
		delete normalized.limit;
	}

	return normalized;
}

function formatInputValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isNaN(value) ? "NaN" : String(value);
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatSourceCheckResult(artifact: ResearchArtifact, getSearchContentTool: string | null = DEFAULT_TOOL_NAMES.getSearchContent): string {
	const assessment = artifact.claims?.[0];
	const lines = [`# Source check: ${artifact.query}`, ""];
	if (assessment) {
		lines.push(`**Status:** ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`);
		lines.push(`**Rationale:** ${assessment.rationale}`);
		if (assessment.supporting_passages.length > 0) lines.push(`**Supporting passages:** ${assessment.supporting_passages.join(", ")}`);
		if (assessment.contradicting_passages.length > 0) lines.push(`**Contradicting passages:** ${assessment.contradicting_passages.join(", ")}`);
		lines.push("");
	}
	if (artifact.sources.length > 0) {
		lines.push("## Sources");
		for (const source of artifact.sources) lines.push(`${source.rank}. [${source.quality}] ${source.title}\n   ${source.url}`);
		lines.push("");
	}
	if (artifact.errors?.length) lines.push(`Search errors: ${artifact.errors.map((entry) => `${entry.query}: ${entry.error}`).join("; ")}`);
	lines.push(getSearchContentTool
		? `Artifact responseId: ${artifact.id} (retrievable via ${getSearchContentTool}).`
		: `Artifact responseId: ${artifact.id}. Content retrieval is not registered.`);
	return lines.join("\n");
}

function duplicateQuerySet(results: QueryResultData[]): Set<string> {
	const counts = new Map<string, number>();
	for (const result of results) {
		counts.set(result.query, (counts.get(result.query) ?? 0) + 1);
	}
	const duplicates = new Set<string>();
	for (const [query, count] of counts) {
		if (count > 1) duplicates.add(query);
	}
	return duplicates;
}

function formatQueryHeader(query: string, provider: string | undefined, duplicateQueries: Set<string>): string {
	const suffix = duplicateQueries.has(query) && provider ? ` (${provider})` : "";
	return `## Query: "${query}"${suffix}\n\n`;
}

function hasFullInlineCoverage(urls: string[], inlineContent: ExtractedContent[] | undefined): boolean {
	if (!inlineContent || inlineContent.length === 0) return false;
	const coveredUrls = new Set(inlineContent.map(c => c.url));
	return urls.every(url => coveredUrls.has(url));
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	const providers = queryData.providers ?? (queryData.provider ? [queryData.provider] : []);
	if (providers.length > 0) output += `**Provider${providers.length === 1 ? "" : "s"}:** ${providers.join(", ")}\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}${r.snippet ? `\n\n${r.snippet}` : ""}\n\n`;
	}
	return output;
}

function boundSearchPresentation(
	text: string,
	guidance: string,
	truncationGuidance: string,
	maxChars: number,
): { text: string; truncated: boolean; originalChars: number; returnedChars: number; omittedChars: number } {
	const fullText = `${text}${guidance}`;
	if (fullText.length <= maxChars) {
		return { text: fullText, truncated: false, originalChars: text.length, returnedChars: text.length, omittedChars: 0 };
	}
	const marker = `\n\n---\n[Output truncated.]${truncationGuidance}`;
	// Reserve marker space so the complete model-visible response never exceeds the configured ceiling.
	const prefixLength = maxChars - marker.length;
	const bounded = `${text.slice(0, prefixLength)}${marker}`;
	return {
		text: bounded,
		truncated: true,
		originalChars: text.length,
		returnedChars: prefixLength,
		omittedChars: text.length - prefixLength,
	};
}

export type SummaryWorkflow = "summary-review" | "auto-summary";
export type FetchedContentData = StoredSearchData & { type: "fetch"; urls: ExtractedContent[] };

export interface SearchReturnOptions {
	queryList: string[];
	results: QueryResultData[];
	urls: string[];
	includeContent: boolean;
	inlineContent?: ExtractedContent[];
	curated?: boolean;
	curatedFrom?: number;
	workflow?: SummaryWorkflow;
	approvedSummary?: string;
	summaryMeta?: SummaryMeta;
	proxy?: string;
}

/** Tool names and limits a host resolved once at startup. */
export interface WebToolCoreSettings {
	toolNames: ToolNames;
	enabledTools: Record<keyof ToolNames, boolean>;
	/** Output ceiling for search results and stored-content pages. fetch_content rereads config per call. */
	maxInlineContentChars: number;
	fetchModes: FetchModeConfig;
}

export interface PageAnswerRequest {
	question: string;
	pageText: string;
	sourceUrl: string;
	model?: string;
}

/** Everything that differs between hosts. Pi supplies session persistence, background
 * notifications, and page answers; the standalone host keeps results in memory only. */
export interface WebToolCoreHost {
	settings: WebToolCoreSettings;
	/** Store fetched page content under id so the retrieval tool can page through it. */
	storeFetchedContent(id: string, data: FetchedContentData): void;
	/** Called after search or research results are stored in memory. */
	publishResult?(data: StoredSearchData): void;
	/** Fetch includeContent pages the provider did not cover in the background and return
	 * their responseId. When omitted, web_search awaits the same fetch before returning. */
	startBackgroundFetch?(urls: string[], proxy?: string, provided?: ExtractedContent[]): string | null;
	/** Answers fetch_content mode "answer"; requires the host's model access. */
	answerFromPage?(request: PageAnswerRequest, extensionContext: ExtensionContext | undefined, signal?: AbortSignal): Promise<{ text: string }>;
	/** Extraction options every fetch in this host adds (for example direct-image policy). */
	extractOptions?: Pick<ExtractOptions, "rejectDirectImages">;
}

export type WebToolUpdate = (update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void;

/** Per-call inputs only Pi has: its live ExtensionContext and partial-result callback. */
export interface WebToolCallOptions {
	extensionContext?: ExtensionContext;
	onUpdate?: WebToolUpdate;
}

export interface WebSearchCallOptions extends WebToolCallOptions {
	/** Generates an auto-summary after searches complete; returning a tool result ends the call. */
	summarize?(results: QueryResultData[]): Promise<WebToolResult | { approvedSummary: string; summaryMeta: SummaryMeta }>;
}

// Pi's TypeBox schemas type enums as plain strings; the core normalizes them.
export type WebSearchParams = Omit<WebSearchCallParams, "recencyFilter"> & { recencyFilter?: string; workflow?: string };
export type FetchContentToolParams = FetchContentCallParams & FetchContentParams;
export type SourceCheckParams = Omit<SourceCheckCallParams, "recencyFilter"> & { recencyFilter?: string };

export interface WebToolCoreInstance extends WebToolCore {
	webSearch(params: WebSearchParams, signal?: AbortSignal, call?: WebSearchCallOptions): Promise<WebToolResult>;
	fetchContent(params: FetchContentToolParams, signal?: AbortSignal, call?: WebToolCallOptions): Promise<WebToolResult>;
	getSearchContent(params: RawGetSearchContentParams, signal?: AbortSignal): Promise<WebToolResult>;
	sourceCheck(params: SourceCheckParams, signal?: AbortSignal, call?: WebToolCallOptions): Promise<WebToolResult>;
	/** Formats and stores search results; the Pi curator reuses it for curated returns. */
	buildSearchReturn(opts: SearchReturnOptions): WebToolResult;
}

/** Names fetch failure guidance may point at: only tools registered this session. */
export function registeredFetchToolNames(settings: WebToolCoreSettings): NonNullable<ExtractOptions["toolNames"]> {
	return {
		...(settings.enabledTools.webSearch ? { webSearch: settings.toolNames.webSearch } : {}),
		...(settings.enabledTools.fetchContent ? { fetchContent: settings.toolNames.fetchContent } : {}),
	};
}

export function storedContentSourceNames(settings: WebToolCoreSettings): string {
	return joinToolNames([
		...(settings.enabledTools.webSearch ? [settings.toolNames.webSearch] : []),
		...(settings.enabledTools.sourceCheck ? [settings.toolNames.sourceCheck] : []),
		...(settings.enabledTools.fetchContent ? [settings.toolNames.fetchContent] : []),
	]);
}

/** Slices content from offset and appends the next-slice instructions, shrinking
 * the slice so the whole page, instructions included, stays within maxChars. */
function sliceWithContinuation(content: string, offset: number, limit: number, maxChars: number, continuationAt: (endOffset: number) => string): { endOffset: number; text: string } {
	let endOffset = offset + Math.min(limit, content.length - offset);
	let continuation = "";
	while (endOffset < content.length) {
		continuation = continuationAt(endOffset);
		const overflow = endOffset - offset + continuation.length - maxChars;
		if (overflow <= 0) break;
		endOffset -= overflow;
	}
	return { endOffset, text: content.slice(offset, endOffset) + (endOffset < content.length ? continuation : "") };
}

export function createWebToolCore(host: WebToolCoreHost): WebToolCoreInstance {
	const { settings } = host;
	const toolNames = settings.toolNames;
	const getSearchContentEnabled = settings.enabledTools.getSearchContent;
	const fetchModeConfig = settings.fetchModes;
	const registeredToolNames = registeredFetchToolNames(settings);
	const storedContentSources = storedContentSourceNames(settings);

	function fetchOptions(options: ExtractOptions | undefined, proxy?: string): ExtractOptions {
		const merged = host.extractOptions ? { ...(options ?? {}), ...host.extractOptions } : options;
		return withRegisteredFetchOptions(merged, registeredToolNames, proxy);
	}

	function storeFetchResult(responseId: string, data: FetchedContentData, authProfile?: AuthFetchProfile): boolean {
		if (authProfile?.cache === "off") return false;
		host.storeFetchedContent(responseId, data);
		return true;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id, type: "search", timestamp: Date.now(), queries: results,
		};
		storeResult(id, data);
		host.publishResult?.(data);
		return id;
	}

	function buildSearchReturn(opts: SearchReturnOptions): WebToolResult {
		const sc = opts.results.filter(r => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		const hasApprovedSummary = typeof opts.approvedSummary === "string" && opts.approvedSummary.trim().length > 0;
		const maxInlineContentChars = settings.maxInlineContentChars;
		let output = "";
		if (hasApprovedSummary) {
			output = opts.approvedSummary!.trim();
		} else {
			if (opts.curated) {
				output += "[These results were manually curated by the user in the browser. Use them as-is — do not re-search or discard.]\n\n";
			}
			const providerNames = opts.results.map(result => {
				const providers = result.providers ?? (result.provider ? [result.provider] : []);
				return providers.join(", ") || "unknown";
			});
			output += opts.results.length === 1
				? `**Provider:** ${providerNames[0]}\n\n`
				: `**Providers used:** ${providerNames.map((name, index) => `Query ${index + 1}: ${name}`).join("; ")}\n\n`;
			const duplicateQueries = opts.curated ? duplicateQuerySet(opts.results) : new Set<string>();
			for (const { query, answer, results, error, provider } of opts.results) {
				if (opts.queryList.length > 1) {
					output += opts.curated
						? formatQueryHeader(query, provider, duplicateQueries)
						: `## Query: "${query}"\n\n`;
				}
				if (error) output += `Error: ${error}\n\n`;
				else output += formatSearchSummary(results, answer) + "\n\n";
			}
		}

		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		let fetchId: string | null = null;
		if (hasInlineReady && opts.inlineContent) {
			fetchId = generateId();
			const data = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			} satisfies FetchedContentData;
			host.storeFetchedContent(fetchId, data);
		} else if (opts.includeContent) {
			fetchId = host.startBackgroundFetch?.(opts.urls, opts.proxy, opts.inlineContent) ?? null;
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !hasInlineReady;
		const unboundedPresentation = output.trim();
		const buildGuidance = (forTruncation: boolean): string => {
			let value = "";
			if (hasInlineReady && opts.inlineContent && fetchId) {
				value += `\n---\nFull content for ${opts.inlineContent.length} sources is ready as responseId "${fetchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${fetchId}", urlIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page.`
					: forTruncation ? `Enable ${toolNames.getSearchContent} to retrieve the full stored content.` : "";
			} else if (isBackgroundFetch && fetchId) {
				value += `\n---\nContent fetching in background as responseId "${fetchId}". Will notify when ready.`;
			}
			if (getSearchContentEnabled || forTruncation) {
				value += `\n---\nFull search results are stored as responseId "${searchId}". `;
				value += getSearchContentEnabled
					? `Use ${toolNames.getSearchContent}({ responseId: "${searchId}", queryIndex: 0, offset: 0, limit: ${maxInlineContentChars} }) to retrieve the first bounded page${opts.results.length > 1 ? `; repeat with queryIndex 1 through ${opts.results.length - 1}` : ""}.`
					: `Enable ${toolNames.getSearchContent} to retrieve the full stored results.`;
			}
			return value;
		};
		const presentation = hasApprovedSummary
			? { text: unboundedPresentation, truncated: false, originalChars: unboundedPresentation.length, returnedChars: unboundedPresentation.length, omittedChars: 0 }
			: boundSearchPresentation(unboundedPresentation, buildGuidance(false), buildGuidance(true), maxInlineContentChars);

		return {
			content: [{ type: "text", text: presentation.text }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
				queryProviders: opts.results.map(result => ({
					query: result.query,
					providers: result.providers ?? (result.provider ? [result.provider] : []),
				})),
				truncated: presentation.truncated,
				originalChars: presentation.originalChars,
				returnedChars: presentation.returnedChars,
				omittedChars: presentation.omittedChars,
				...(opts.curated ? {
					curated: true,
					curatedFrom: opts.curatedFrom,
					curatedQueries: opts.results.map(r => ({
						query: r.query,
						provider: r.provider || null,
						answer: r.answer || null,
						sources: r.results.map(s => ({ title: s.title, url: s.url })),
						error: r.error,
					})),
				} : {}),
				...((opts.workflow && hasApprovedSummary)
					? {
						summary: {
							text: opts.approvedSummary!.trim(),
							workflow: opts.workflow,
							model: opts.summaryMeta?.model ?? null,
							durationMs: opts.summaryMeta?.durationMs ?? 0,
							tokenEstimate: opts.summaryMeta?.tokenEstimate ?? 0,
							fallbackUsed: opts.summaryMeta?.fallbackUsed === true,
							fallbackReason: opts.summaryMeta?.fallbackReason,
							phase: opts.summaryMeta?.phase,
							edited: opts.summaryMeta?.edited === true,
						},
					}
					: {}),
			},
		};
	}

	async function webSearch(params: WebSearchParams, signal?: AbortSignal, call: WebSearchCallOptions = {}): Promise<WebToolResult> {
		const { extensionContext: ctx, onUpdate } = call;
		return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? expandQueryString(params.query) : []);
			const queryList = normalizeQueryList(rawQueryList);
			const recencyFilter = normalizeRecencyFilter(params.recencyFilter);

			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			let completedSearches = 0;
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = resolveRequestedProvider(params.provider);

			const queryResponses = await runSearchQueries(queryList, async (query) => {
				signal?.throwIfAborted();
				onUpdate?.({
					content: [{ type: "text", text: `Searching "${query}" (${completedSearches}/${queryList.length} complete)...` }],
					details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider, providerResponses } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						category: params.category,
						signal,
						extensionContext: ctx,
					});

					const providers = providerResponses?.map(response => response.provider) ?? [provider];
					return { result: { query, answer, results, error: null, provider, providers } satisfies QueryResultData, inlineContent };
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const requestedProvider = toCuratorProvider(resolvedProvider);
					return {
						result: { query, answer: "", results: [], error: message, provider: requestedProvider } satisfies QueryResultData,
						inlineContent: undefined,
					};
				} finally {
					completedSearches++;
					if (!signal?.aborted) {
						onUpdate?.({
							content: [{ type: "text", text: `Completed ${completedSearches}/${queryList.length} searches.` }],
							details: { phase: "search", progress: completedSearches / queryList.length, currentQuery: query },
						});
					}
				}
			});
			const searchResults = queryResponses.map(response => response.result);
			for (const response of queryResponses) {
				for (const result of response.result.results) {
					if (!allUrls.includes(result.url)) allUrls.push(result.url);
				}
				if (response.inlineContent) allInlineContent.push(...response.inlineContent);
			}

			let approvedSummary: string | undefined;
			let summaryMeta: SummaryMeta | undefined;
			if (call.summarize) {
				const summary = await call.summarize(searchResults);
				if ("content" in summary) return summary;
				approvedSummary = summary.approvedSummary;
				summaryMeta = summary.summaryMeta;
			}

			let inlineContent = allInlineContent.length > 0 ? allInlineContent : undefined;
			if (params.includeContent && !host.startBackgroundFetch && allUrls.length > 0 && !hasFullInlineCoverage(allUrls, inlineContent)) {
				// Hosts without background notifications wait for the same page fetch instead.
				const proxy = typeof params.proxy === "string" ? params.proxy : undefined;
				const fetched = await fetchUncoveredContent(allUrls, inlineContent, urls => fetchAllContent(urls, signal, fetchOptions(undefined, proxy)));
				signal?.throwIfAborted();
				inlineContent = stripThumbnails(fetched);
			}

			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent,
				workflow: call.summarize ? "auto-summary" : undefined,
				approvedSummary,
				summaryMeta,
				proxy: typeof params.proxy === "string" ? params.proxy : undefined,
			});
		});
	}

	async function sourceCheck(params: SourceCheckParams, signal?: AbortSignal, call: WebToolCallOptions = {}): Promise<WebToolResult> {
		const ctx = call.extensionContext;
		return runWithProxy(typeof params.proxy === "string" ? params.proxy : undefined, async () => {
			const claim = typeof params.claim === "string" ? params.claim.trim() : "";
			if (!claim) {
				return { content: [{ type: "text", text: "Error: 'claim' is required." }], details: { error: "Missing claim" } };
			}

			const requestedQueries = Array.isArray(params.queries)
				? params.queries.filter((query): query is string => typeof query === "string").map((query) => query.trim()).filter(Boolean)
				: [];
			const queries = (requestedQueries.length > 0 ? requestedQueries : [claim]).slice(0, 8);
			const numResults = typeof params.numResults === "number" && Number.isFinite(params.numResults)
				? Math.min(20, Math.max(1, Math.floor(params.numResults)))
				: 5;
			const domainFilter = Array.isArray(params.domainFilter)
				? params.domainFilter.filter((domain): domain is string => typeof domain === "string")
				: undefined;
			const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
			const resultsByUrl = new Map<string, SearchResult>();
			const summaries: string[] = [];
			const errors: Array<{ query: string; error: string }> = [];
			let provider: string | undefined;

			for (const query of queries) {
				if (signal?.aborted) break;
				try {
					const response = await search(query, {
						provider: resolveRequestedProvider(params.provider),
						numResults,
						recencyFilter,
						domainFilter,
						signal,
						extensionContext: ctx,
					});
					if (signal?.aborted) break;
					provider ??= response.provider;
					if (response.answer) summaries.push(`${query}: ${response.answer}`);
					for (const result of response.results) {
						if (!resultsByUrl.has(result.url)) resultsByUrl.set(result.url, result);
					}
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) break;
					errors.push({ query, error: err instanceof Error ? err.message : String(err) });
				}
			}

			const results = [...resultsByUrl.values()].slice(0, 20).map((result, index) => ({ ...result, rank: index + 1 }));
			let fetched: ExtractedContent[] = [];
			if (params.fetchContent && results.length > 0) {
				const urls = results.slice(0, 5).map((result) => result.url);
				try {
					fetched = await fetchAllContent(urls, signal, fetchOptions(undefined, typeof params.proxy === "string" ? params.proxy : undefined));
				} catch (err) {
					if (signal?.aborted || isAbortError(err)) throw err;
					fetched = urls.map((url) => ({ url, title: "", content: "", error: err instanceof Error ? err.message : String(err) }));
				}
			}
			const artifact = withClaimAssessment(buildResearchArtifact({
				query: claim,
				provider,
				summary: summaries.length > 0 ? summaries.join("\n\n") : undefined,
				results,
				fetched,
				recency: recencyFilter,
				domainFilter,
			}), [claim]);
			if (errors.length > 0) artifact.errors = errors;
			storeResearchArtifact(artifact);
			host.publishResult?.({
				id: artifact.id,
				type: "research",
				timestamp: artifact.timestamp,
				artifact,
			});
			return {
				content: [{ type: "text", text: formatSourceCheckResult(artifact, getSearchContentEnabled ? toolNames.getSearchContent : null) }],
				details: { responseId: artifact.id, artifact, sourceCount: artifact.sources.length, passageCount: artifact.passages.length, searchCount: queries.length },
			};
		});
	}

	async function fetchContent(params: FetchContentToolParams, signal?: AbortSignal, call: WebToolCallOptions = {}): Promise<WebToolResult> {
		const { extensionContext: ctx, onUpdate } = call;
		let normalized: ReturnType<typeof normalizeFetchContentParams>;
		try {
			normalized = normalizeFetchContentParams(params);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
		}
		const { urlList, options } = normalized;
		const mode = options.mode ?? fetchModeConfig.defaultMode;
		if (!fetchModeConfig.allowedModes.includes(mode)) {
			const error = `Fetch mode "${mode}" is disabled by fetch.allowedModes.`;
			return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
		}
		return runWithProxy(options.proxy, async () => {
			if (mode === "answer" && !options.prompt) {
				return { content: [{ type: "text", text: "Error: mode answer requires prompt." }], details: { error: "mode answer requires prompt" } };
			}
			if (mode === "raw" && (options.forceClone === true || options.timestamp || options.frames || options.prompt || options.model || options.answerModel)) {
				return { content: [{ type: "text", text: "Error: mode raw cannot be combined with forceClone, prompt, timestamp, frames, model, or answerModel." }], details: { error: "Incompatible raw mode options" } };
			}
			if (mode !== "answer" && options.answerModel) {
				return { content: [{ type: "text", text: "Error: answerModel requires mode answer." }], details: { error: "answerModel requires mode answer" } };
			}
			if (mode === "answer" && options.model) {
				return { content: [{ type: "text", text: "Error: use answerModel, not model, with mode answer." }], details: { error: "model is incompatible with mode answer" } };
			}
			if (mode === "answer" && options.auth !== undefined) {
				return { content: [{ type: "text", text: "Error: auth cannot be combined with mode answer." }], details: { error: "auth cannot be combined with mode answer" } };
			}
			let authFetchProfile: AuthFetchProfile | undefined;
			if (options.auth !== undefined) {
				try {
					authFetchProfile = resolveAuthFetchProfile(options.auth);
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
				}
			}
			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			const { answerModel: _answerModel, auth: _auth, ...extractionOptions } = { ...options, mode };
			const { prompt: _prompt, ...answerExtractionOptions } = extractionOptions;
			const requestOptions = {
				...(mode === "answer" ? answerExtractionOptions : extractionOptions),
				...(authFetchProfile ? { authFetchProfile } : {}),
			};
			const fetchResults = await fetchAllContent(urlList, signal, fetchOptions(requestOptions, options.proxy));
			const presentedResults = mode === "answer"
				? await Promise.all(fetchResults.map(async result => {
					if (result.error) return result;
					if (result.thumbnail || result.mimeType?.startsWith("image/")) {
						return { ...result, error: "Page answer requires textual fetched content" };
					}
					try {
						if (!host.answerFromPage) throw new Error("this host cannot answer from fetched pages");
						const answer = await host.answerFromPage({
							question: options.prompt!,
							pageText: result.content,
							sourceUrl: result.url,
							...(options.answerModel ? { model: options.answerModel } : {}),
						}, ctx, signal);
						return { ...result, content: answer.text };
					} catch (err) {
						return { ...result, error: `Page answer failed: ${err instanceof Error ? err.message : String(err)}` };
					}
				}))
				: fetchResults;
			const successful = presentedResults.filter((r) => !r.error).length;
			const totalChars = presentedResults.reduce((sum, r) => sum + r.content.length, 0);

			const responseId = generateId();
			const data = {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: stripThumbnails(fetchResults),
			} satisfies FetchedContentData;
			const storedContent = storeFetchResult(responseId, data, authFetchProfile);

			if (urlList.length === 1) {
				const result = presentedResults[0];
				if (result.error) {
					return {
						isError: true,
						content: [{ type: "text", text: `Error: ${result.error}` }],
						details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, ...(storedContent ? { responseId } : {}), prompt: params.prompt, timestamp: params.timestamp, frames: params.frames },
					};
				}

				const fullLength = result.content.length;
				const slice = initialContentSlice(result.content, getMaxInlineContentChars());
				const truncated = slice.endOffset < fullLength;
				let output = slice.text;

				if (truncated) {
					output += `\n\n---\nShowing ${slice.endOffset} of ${fullLength} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. `;
					output += storedContent
						? getSearchContentEnabled
							? `Use ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`
							: "Content retrieval is not registered."
						: "Authenticated fetch cache is off; repeat the fetch to read more.";
				}

				const content: WebToolContent[] = [];
				if (result.frames?.length) {
					for (const frame of result.frames) {
						content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
						content.push({ type: "text", text: `Frame at ${frame.timestamp}` });
					}
				} else if (result.thumbnail) {
					content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
				}
				content.push({ type: "text", text: output });

				const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
				return {
					content,
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: result.title,
						...(storedContent ? { responseId } : {}),
						truncated,
						hasImage: imageCount > 0,
						imageCount,
						prompt: params.prompt,
						timestamp: params.timestamp,
						frames: params.frames,
						duration: result.duration,
						mode,
						mimeType: result.mimeType,
						status: result.status,
						totalBytes: slice.totalBytes,
						totalLines: slice.totalLines,
						shownBytes: slice.shownBytes,
						shownLines: slice.shownLines,
					},
				};
			}

			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of presentedResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			output += storedContent
				? getSearchContentEnabled
					? `\n---\nUse ${toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`
					: "\n---\nContent retrieval is not registered."
				: "\n---\nAuthenticated fetch cache is off; repeat the fetch to read content.";

			return {
				...(successful === 0 ? { isError: true } : {}),
				content: [{ type: "text", text: output }],
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars, ...(storedContent ? { responseId } : {}) },
			};
		});
	}

	async function getSearchContent(rawParams: RawGetSearchContentParams): Promise<WebToolResult> {
		const maxInlineContentChars = settings.maxInlineContentChars;
		const params = normalizeGetSearchContentParams(rawParams);
		if (params.findMode !== undefined && params.findText === undefined) {
			return {
				content: [{ type: "text", text: `findMode ${formatInputValue(params.findMode)} requires findText; provide findText or omit findMode.` }],
				details: { error: "findMode requires findText" },
			};
		}
		const data = getResult(params.responseId);
		if (!data) {
			return {
				content: [{ type: "text", text: `Error: No stored results for responseId ${formatInputValue(params.responseId)}. Use a responseId returned by ${storedContentSources}.` }],
				details: { error: "Not found", responseId: params.responseId },
			};
		}

		if (data.type === "research") {
			const artifact = getResearchArtifact(params.responseId);
			if (!artifact) {
				return {
					content: [{ type: "text", text: `Error: stored research artifact for responseId ${formatInputValue(params.responseId)} was not found. Use a responseId returned by ${storedContentSources}.` }],
					details: { error: "Artifact not found", responseId: params.responseId },
				};
			}
			const serialized = JSON.stringify(artifact, null, 2);
			if (params.findText !== undefined) {
				try {
					const found = findContent(serialized, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
					const { text, ...findDetails } = found;
					return {
						content: [{ type: "text", text }],
						details: { responseId: artifact.id, type: "research", contentLength: serialized.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
					};
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in research artifact for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
						details: { error, responseId: params.responseId, type: "research" },
					};
				}
			}
			const offset = params.offset ?? 0;
			const limit = params.limit ?? maxInlineContentChars;
			if (!Number.isInteger(offset) || offset < 0) {
				return {
					content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for responseId ${formatInputValue(params.responseId)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
					details: { error: "Invalid offset", offset },
				};
			}
			if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
				return {
					content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for responseId ${formatInputValue(params.responseId)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
					details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
				};
			}
			if (offset > serialized.length) {
				return {
					content: [{ type: "text", text: `Offset ${offset} is out of range for responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${serialized.length}. Use an offset within that range.` }],
					details: { error: "Offset out of range", offset, contentLength: serialized.length },
				};
			}
			const { endOffset, text } = sliceWithContinuation(serialized, offset, limit, maxInlineContentChars, (end) =>
				`\n\n---\nShowing chars ${offset}-${end} of ${serialized.length}. Use ${toolNames.getSearchContent}({ responseId: "${artifact.id}", offset: ${end}, limit: ${limit} }) for the next slice.`);
			const hasMore = endOffset < serialized.length;
			return {
				content: [{ type: "text", text }],
				details: { responseId: artifact.id, type: "research", contentLength: serialized.length, offset, limit, returnedChars: endOffset - offset, nextOffset: hasMore ? endOffset : null, truncated: hasMore },
			};
		}

		if (data.type === "search" && data.queries) {
			let queryData: QueryResultData | undefined;

			if (params.query !== undefined) {
				queryData = data.queries.find((q) => q.query === params.query);
				if (!queryData) {
					const available = data.queries.map((q) => `"${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Query ${formatInputValue(params.query)} was not found for responseId ${formatInputValue(params.responseId)}. Received query=${formatInputValue(params.query)}. Available queries: ${available || "none"}. Use one of the available queries or queryIndex.` }],
						details: { error: "Query not found" },
					};
				}
			} else if (params.queryIndex !== undefined) {
				queryData = data.queries[params.queryIndex];
				if (!queryData) {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Query index ${formatInputValue(params.queryIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received queryIndex=${formatInputValue(params.queryIndex)}; valid indexes are 0-${data.queries.length - 1}. Available queries: ${available || "none"}. Use one of the available indexes.` }],
						details: { error: "Index out of range" },
					};
				}
			} else {
				const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
				return {
					content: [{ type: "text", text: `Specify query or queryIndex for responseId ${formatInputValue(params.responseId)}. Available queries: ${available || "none"}.` }],
					details: { error: "No query specified" },
				};
			}

			if (queryData.error) {
				return {
					content: [{ type: "text", text: `Error retrieving query ${formatInputValue(queryData.query)} from responseId ${formatInputValue(params.responseId)}: ${queryData.error}. Check the stored search result and retry with another query or queryIndex if needed.` }],
					details: { error: queryData.error, query: queryData.query },
				};
			}

			const fullResults = formatFullResults(queryData);
			if (params.findText !== undefined) {
				try {
					const found = findContent(fullResults, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
					const { text, ...findDetails } = found;
					return {
						content: [{ type: "text", text }],
						details: { responseId: params.responseId, query: queryData.query, resultCount: queryData.results.length, contentLength: fullResults.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
					};
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in query ${formatInputValue(queryData.query)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
						details: { error, query: queryData.query },
					};
				}
			}

			const offset = params.offset ?? 0;
			const limit = params.limit ?? maxInlineContentChars;
			if (!Number.isInteger(offset) || offset < 0) {
				return {
					content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for query ${formatInputValue(queryData.query)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
					details: { error: "Invalid offset", offset },
				};
			}
			if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
				return {
					content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for query ${formatInputValue(queryData.query)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
					details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
				};
			}
			if (offset > fullResults.length) {
				return {
					content: [{ type: "text", text: `Offset ${offset} is out of range for query ${formatInputValue(queryData.query)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${fullResults.length}. Use an offset within that range.` }],
					details: { error: "Offset out of range", offset, contentLength: fullResults.length },
				};
			}
			const queryIndex = data.queries.indexOf(queryData);
			const { endOffset, text } = sliceWithContinuation(fullResults, offset, limit, maxInlineContentChars, (end) =>
				`\n\n---\nShowing chars ${offset}-${end} of ${fullResults.length}. Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", queryIndex: ${queryIndex}, offset: ${end}, limit: ${limit} }) for the next slice.`);
			const returnedChars = endOffset - offset;
			const hasMore = endOffset < fullResults.length;
			return {
				content: [{ type: "text", text }],
				details: {
					responseId: params.responseId,
					query: queryData.query,
					resultCount: queryData.results.length,
					contentLength: fullResults.length,
					offset,
					limit,
					returnedChars,
					nextOffset: hasMore ? endOffset : null,
					truncated: hasMore,
				},
			};
		}

		if (data.type === "fetch" && data.urls) {
			let urlData: ExtractedContent | undefined;
			let selectedUrlIndex = -1;

			if (params.url !== undefined) {
				selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url);
				urlData = data.urls[selectedUrlIndex];
				if (!urlData) {
					const available = data.urls.map((u) => u.url).join("\n  ");
					return {
						content: [{ type: "text", text: `URL ${formatInputValue(params.url)} was not found for responseId ${formatInputValue(params.responseId)}. Received url=${formatInputValue(params.url)}. Available URLs:\n  ${available || "  none"}\nUse one of the available URLs or urlIndex.` }],
						details: { error: "URL not found" },
					};
				}
			} else if (params.urlIndex !== undefined) {
				selectedUrlIndex = params.urlIndex;
				urlData = data.urls[selectedUrlIndex];
				if (!urlData) {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `URL index ${formatInputValue(params.urlIndex)} is out of range for responseId ${formatInputValue(params.responseId)}. Received urlIndex=${formatInputValue(params.urlIndex)}; valid indexes are 0-${data.urls.length - 1}. Available URLs:\n  ${available || "  none"}\nUse one of the available indexes.` }],
						details: { error: "Index out of range" },
					};
				}
			} else if (data.urls.length === 1) {
				// Single stored URL: default to it so calls that omit url and urlIndex
				// (common with findText on single-URL fetches) succeed without a retry.
				selectedUrlIndex = 0;
				urlData = data.urls[0];
			} else {
				const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
				return {
					content: [{ type: "text", text: `Specify url or urlIndex for responseId ${formatInputValue(params.responseId)}. Available URLs:\n  ${available || "  none"}` }],
					details: { error: "No URL specified" },
				};
			}

			if (urlData.error) {
				return {
					content: [{ type: "text", text: `Error retrieving URL ${formatInputValue(urlData.url)} from responseId ${formatInputValue(params.responseId)}: ${urlData.error}. Check the stored fetch result and retry with another URL or urlIndex if needed.` }],
					details: { error: urlData.error, url: urlData.url },
				};
			}

			if (params.findText !== undefined) {
				try {
					const found = findContent(urlData.content, normalizeFindQueries(params.findText), params.findMode ?? "case-insensitive");
					const { text, ...findDetails } = found;
					return {
						content: [{ type: "text", text: `# ${urlData.title || urlData.url}\n\n${text}` }],
						details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length, findMode: params.findMode ?? "case-insensitive", ...findDetails },
					};
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Unable to find ${formatInputValue(params.findText)} in URL ${formatInputValue(urlData.url)} for responseId ${formatInputValue(params.responseId)}: ${error}. Check findText and use a supported findMode.` }],
						details: { error, url: urlData.url },
					};
				}
			}

			const offset = params.offset ?? 0;
			const limit = params.limit ?? maxInlineContentChars;
			if (!Number.isInteger(offset) || offset < 0) {
				return {
					content: [{ type: "text", text: `Invalid offset: received ${formatInputValue(offset)} for URL ${formatInputValue(urlData.url)}; offset must be a non-negative integer. Use 0 or a larger integer.` }],
					details: { error: "Invalid offset", offset },
				};
			}
			if (!Number.isInteger(limit) || limit <= 0 || limit > maxInlineContentChars) {
				return {
					content: [{ type: "text", text: `Invalid limit: received ${formatInputValue(limit)} for URL ${formatInputValue(urlData.url)}; limit must be an integer from 1 to ${maxInlineContentChars}. Use a value in that range.` }],
					details: { error: "Invalid limit", limit, maxLimit: maxInlineContentChars },
				};
			}
			if (offset > urlData.content.length) {
				return {
					content: [{ type: "text", text: `Offset ${offset} is out of range for URL ${formatInputValue(urlData.url)} in responseId ${formatInputValue(params.responseId)}. Received offset ${offset}; valid range is 0-${urlData.content.length}. Use an offset within that range.` }],
					details: { error: "Offset out of range", offset, contentLength: urlData.content.length },
				};
			}

			const endOffset = Math.min(offset + limit, urlData.content.length);
			const contentSlice = urlData.content.slice(offset, endOffset);
			const hasMore = endOffset < urlData.content.length;
			let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`;
			if (hasMore || offset > 0) {
				text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`;
				if (hasMore) {
					text += ` Use ${toolNames.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
				}
			}

			return {
				content: [{ type: "text", text }],
				details: {
					url: urlData.url,
					title: urlData.title,
					contentLength: urlData.content.length,
					offset,
					limit,
					returnedChars: contentSlice.length,
					nextOffset: hasMore ? endOffset : null,
					truncated: hasMore,
				},
			};
		}

		return {
			content: [{ type: "text", text: `Invalid stored data for responseId ${formatInputValue(params.responseId)}: received type ${formatInputValue(data.type)}. Use a responseId returned by ${storedContentSources}.` }],
			details: { error: "Invalid data" },
		};
	}

	return {
		webSearch,
		fetchContent,
		getSearchContent,
		sourceCheck,
		buildSearchReturn,
	};
}

const MAX_STORED_RESULTS = 50;
const STANDALONE_DIRECT_IMAGE_ERROR = "Direct image fetch is not supported over MCP; fetch_content returns text there. Fetch images from the Pi extension instead.";

export interface StandaloneWebToolCore extends WebToolCore {
	/** Default names of the tools web-search.json enables; hosts list only these. */
	enabledToolNames: string[];
}

function standaloneError(error: string): WebToolResult {
	return { content: [{ type: "text", text: `Error: ${error}` }], details: { error }, isError: true };
}

// A call where nothing requested succeeded is an error: every web_search query,
// every fetch_content URL, or every source_check search failed. A working search
// with zero matches is not.
function markStandaloneError(result: WebToolResult): WebToolResult {
	const { error, queryCount, successfulQueries, urlCount, successful, searchCount, artifact } = result.details;
	const nothingSucceeded = (typeof queryCount === "number" && queryCount > 0 && successfulQueries === 0)
		|| (typeof urlCount === "number" && urlCount > 0 && successful === 0)
		|| (typeof searchCount === "number" && searchCount > 0 && (artifact as ResearchArtifact).errors?.length === searchCount);
	return error !== undefined || nothingSucceeded ? { ...result, isError: true } : result;
}

// Explicit requests for providers that need Pi's model registry or login state
// fail here instead of silently falling back. Automatic selection already skips
// them without a Pi context and picks among the providers usable here.
async function standaloneProviderRejection(requested: unknown): Promise<string | undefined> {
	let selection: SearchProviderSelection;
	try {
		selection = resolveRequestedProvider(requested);
	} catch {
		return undefined; // The core reports the same validation error.
	}
	const explicit: string[] = Array.isArray(selection) ? selection : [selection];
	if (explicit.includes("kimi")) {
		return "Kimi search is not supported over MCP: it authenticates only through Pi's /login kimi-coding. Choose another provider, or search from Pi.";
	}
	if (explicit.includes("openai")) {
		let available: boolean;
		try {
			available = await isOpenAISearchAvailable();
		} catch {
			return undefined; // The core reports the same configuration error.
		}
		if (!available) {
			return `OpenAI search over MCP needs an API key: set openaiApiKey in ${WEB_SEARCH_CONFIG_PATH} or OPENAI_API_KEY. ChatGPT/Codex sign-in, openaiUseProviderBaseUrl, and Pi model credentials work only inside Pi.`;
		}
	}
	return undefined;
}

function standaloneFetchRejection(params: FetchContentCallParams, fetchModes: FetchModeConfig): string | undefined {
	if (params.mode === "answer") {
		return "fetch_content mode \"answer\" is not supported over MCP: page answers use Pi's models. Use mode \"readable\" or \"raw\".";
	}
	if (params.mode === undefined && fetchModes.defaultMode === "answer") {
		return `fetch.defaultMode in ${WEB_SEARCH_CONFIG_PATH} is "answer", which is not supported over MCP. Pass mode "readable" or "raw".`;
	}
	return undefined;
}

/** Core for hosts without Pi: no extension context, curator, or summaries; results
 * live in a bounded in-memory store; includeContent waits for the page fetch. */
export function createStandaloneWebToolCore(): StandaloneWebToolCore {
	const config = loadConfig();
	const settings: WebToolCoreSettings = {
		toolNames: { ...DEFAULT_TOOL_NAMES },
		enabledTools: {
			webSearch: isToolEnabled(config, "webSearch"),
			sourceCheck: isToolEnabled(config, "sourceCheck"),
			fetchContent: isToolEnabled(config, "fetchContent"),
			getSearchContent: isToolEnabled(config, "getSearchContent"),
		},
		maxInlineContentChars: getMaxInlineContentChars(config),
		fetchModes: resolveFetchModeConfig(config),
	};
	const storedIds: string[] = [];
	const remember = (id: string) => {
		storedIds.push(id);
		while (storedIds.length > MAX_STORED_RESULTS) deleteResult(storedIds.shift()!);
	};
	const core = createWebToolCore({
		settings,
		storeFetchedContent(id, data) {
			storeResult(id, data);
			remember(id);
		},
		publishResult(data) {
			remember(data.id);
		},
		extractOptions: { rejectDirectImages: STANDALONE_DIRECT_IMAGE_ERROR },
	});

	return {
		enabledToolNames: (Object.keys(DEFAULT_TOOL_NAMES) as (keyof ToolNames)[])
			.filter((key) => settings.enabledTools[key])
			.map((key) => DEFAULT_TOOL_NAMES[key]),
		async webSearch(params, signal) {
			const rejection = await standaloneProviderRejection(params.provider);
			return rejection ? standaloneError(rejection) : markStandaloneError(await core.webSearch(params, signal));
		},
		async fetchContent(params, signal) {
			const rejection = standaloneFetchRejection(params, settings.fetchModes);
			return rejection ? standaloneError(rejection) : markStandaloneError(await core.fetchContent(params, signal));
		},
		async getSearchContent(params, signal) {
			return markStandaloneError(await core.getSearchContent(params, signal));
		},
		async sourceCheck(params, signal) {
			const rejection = await standaloneProviderRejection(params.provider);
			return rejection ? standaloneError(rejection) : markStandaloneError(await core.sourceCheck(params, signal));
		},
	};
}
