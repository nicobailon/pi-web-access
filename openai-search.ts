import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "./activity.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 60_000;

const AUTH_MODEL_CANDIDATES = [
	{ provider: "openai-codex", models: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2", "gpt-5.2-codex"] },
	{ provider: "openai", models: ["gpt-5.4", "gpt-5.2", "gpt-4.1-mini", "gpt-4o"] },
] as const;

interface WebSearchConfig {
	openaiApiKey?: unknown;
}

interface OpenAIAuth {
	provider: "openai-codex" | "openai";
	apiKey: string;
	model: string;
	headers: Record<string, string>;
}

interface NormalizedDomainFilters {
	allowedDomains?: string[];
	blockedDomains?: string[];
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters | null {
	if (!domainFilter?.length) return null;

	const allowedDomains: string[] = [];
	const blockedDomains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blockedDomains : allowedDomains;
		if (!target.includes(domain)) target.push(domain);
	}

	return allowedDomains.length > 0 || blockedDomains.length > 0
		? {
			...(allowedDomains.length > 0 ? { allowedDomains: allowedDomains.slice(0, 100) } : {}),
			...(blockedDomains.length > 0 ? { blockedDomains: blockedDomains.slice(0, 100) } : {}),
		}
		: null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
		const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function isCodexJwt(token: string): boolean {
	const payload = decodeJwtPayload(token);
	return !!payload?.["https://api.openai.com/auth"];
}

function extractAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return undefined;
	const id = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

export async function resolveOpenAIAuth(ctx?: ExtensionContext): Promise<OpenAIAuth | undefined> {
	if (ctx) {
		const { getModel } = await import("@earendil-works/pi-ai/compat");
		for (const candidate of AUTH_MODEL_CANDIDATES) {
			for (const modelId of candidate.models) {
				const model = getModel(candidate.provider, modelId);
				if (!model) continue;
				try {
					const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (resolved.ok && resolved.apiKey) {
						return {
							provider: candidate.provider,
							apiKey: resolved.apiKey,
							model: modelId,
							headers: resolved.headers ?? {},
						};
					}
				} catch {
				}
			}
		}
	}

	const apiKey = normalizeApiKey(process.env.OPENAI_API_KEY) ?? normalizeApiKey(loadConfig().openaiApiKey);
	return apiKey
		? { provider: "openai", apiKey, model: "gpt-5.4", headers: {} }
		: undefined;
}

export async function isOpenAISearchAvailable(ctx?: ExtensionContext): Promise<boolean> {
	return !!(await resolveOpenAIAuth(ctx));
}

function buildInstructions(options: SearchOptions): string {
	const lines = [
		"Search the web and return a concise answer grounded only in the web results.",
		"Include clickable source citations in the response text when possible.",
	];

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
	}

	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
	}

	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters?.allowedDomains?.length) lines.push(`Only use sources from: ${filters.allowedDomains.join(", ")}.`);
	if (filters?.blockedDomains?.length) lines.push(`Do not use sources from: ${filters.blockedDomains.join(", ")}.`);

	return lines.join(" ");
}

function buildWebSearchTool(options: SearchOptions): Record<string, unknown> {
	const tool: Record<string, unknown> = { type: "web_search" };
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters) {
		tool.filters = {
			...(filters.allowedDomains ? { allowed_domains: filters.allowedDomains } : {}),
			...(filters.blockedDomains ? { blocked_domains: filters.blockedDomains } : {}),
		};
	}
	return tool;
}

async function parseOpenAIResponse(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return { output: parsed };
			return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { output: [] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`OpenAI API returned invalid JSON: ${message}`);
		}
	}

	const outputItems: unknown[] = [];
	let completedResponse: Record<string, unknown> | null = null;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data) as Record<string, unknown>;
			if (parsed.type === "response.output_item.done" && parsed.item) outputItems.push(parsed.item);
			if ((parsed.type === "response.done" || parsed.type === "response.completed") && parsed.response && typeof parsed.response === "object") {
				completedResponse = parsed.response as Record<string, unknown>;
			}
		} catch {
		}
	}

	if (completedResponse) {
		const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
		return output.length > 0 ? completedResponse : { ...completedResponse, output: outputItems };
	}
	if (outputItems.length > 0) return { output: outputItems };
	throw new Error("OpenAI API returned no parseable response output");
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return rawUrl.replace(/[?&]utm_source=openai$/, "");
	}
}

function extractSnippetAround(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number" || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(results: SearchResult[], seen: Set<string>, url: unknown, title: unknown, snippet = ""): void {
	if (typeof url !== "string" || url.trim().length === 0) return;
	const cleanUrl = cleanSourceUrl(url);
	if (seen.has(cleanUrl)) return;
	seen.add(cleanUrl);
	results.push({
		title: typeof title === "string" && title.trim().length > 0 ? title : cleanUrl,
		url: cleanUrl,
		snippet,
	});
}

function extractSearchResults(output: unknown[], numResults: number | undefined): SearchResult[] {
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();

	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
			const annotations = (part as { annotations?: unknown }).annotations;
			if (!Array.isArray(annotations)) continue;
			for (const annotation of annotations) {
				if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
				addResult(
					results,
					seenUrls,
					(annotation as { url?: unknown }).url,
					(annotation as { title?: unknown }).title,
					extractSnippetAround(text, (annotation as { start_index?: unknown }).start_index, (annotation as { end_index?: unknown }).end_index),
				);
			}
		}
	}

	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "web_search_call") continue;
		const value = item as { action?: unknown; sources?: unknown; results?: unknown };
		const actionSources = value.action && typeof value.action === "object"
			? (value.action as { sources?: unknown }).sources
			: undefined;
		const sourceGroups = [actionSources, value.sources, value.results];
		for (const group of sourceGroups) {
			if (!Array.isArray(group)) continue;
			for (const source of group) {
				if (!source || typeof source !== "object") continue;
				const record = source as Record<string, unknown>;
				addResult(results, seenUrls, record.url ?? record.source_website_url, record.title ?? record.caption);
			}
		}
	}

	if (typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0) {
		return results.slice(0, Math.min(Math.floor(numResults), 20));
	}
	return results;
}

function extractAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim().length > 0) parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

export async function searchWithOpenAI(
	query: string,
	options: SearchOptions = {},
	ctx?: ExtensionContext,
): Promise<SearchResponse> {
	const auth = await resolveOpenAIAuth(ctx);
	if (!auth) {
		throw new Error(
			"OpenAI web search unavailable. Either:\n" +
			"  1. Use /login to sign in with a Codex subscription\n" +
			`  2. Create ${CONFIG_PATH} with { "openaiApiKey": "your-key" }\n` +
			"  3. Set OPENAI_API_KEY environment variable",
		);
	}

	const activityId = activityMonitor.logStart({ type: "api", query });
	const headers: Record<string, string> = {
		...auth.headers,
		Authorization: `Bearer ${auth.apiKey}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
	};
	const useCodexEndpoint = auth.provider === "openai-codex" || isCodexJwt(auth.apiKey);
	if (useCodexEndpoint) {
		const accountId = extractAccountId(auth.apiKey);
		if (accountId) headers["chatgpt-account-id"] = accountId;
		headers.originator = "pi";
	}

	const body = {
		model: auth.model,
		instructions: buildInstructions(options),
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [buildWebSearchTool(options)],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required" as const,
		parallel_tool_calls: true,
	};

	try {
		const response = await fetch(useCodexEndpoint ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const parsed = await parseOpenAIResponse(response);
		const output = Array.isArray(parsed.output) ? parsed.output : [];
		const answer = extractAnswer(output);
		const results = extractSearchResults(output, options.numResults);

		if (!answer && results.length === 0) {
			throw new Error("OpenAI web_search returned no answer or sources");
		}

		activityMonitor.logComplete(activityId, response.status);
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
