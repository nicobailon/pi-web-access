import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { activityMonitor } from "./activity.js";
import type { ExtractedContent } from "./extract.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

const SEARCH_TIMEOUT_MS = 60_000;

/** Auth info obtained from pi's model registry. */
interface OpenAIAuth {
	provider: string;
	apiKey: string;
	model: string;
}

/**
 * Resolves OpenAI auth from pi's modelRegistry.
 * Tries: openai-codex (Codex OAuth subscription) → openai (API key) → OPENAI_API_KEY env var.
 */
export async function resolveOpenAIAuth(ctx: ExtensionContext): Promise<OpenAIAuth | undefined> {
	const { getModel } = await import("@mariozechner/pi-ai");
	for (const providerId of ["openai-codex", "openai"]) {
		const modelId = providerId === "openai-codex" ? "gpt-5.2" : "gpt-4o";
		try {
			const m = getModel(providerId, modelId);
			if (m) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
				const key = auth?.apiKey;
				if (key) return { provider: providerId, apiKey: key, model: modelId };
			}
		} catch {
			// Model not found or no key — try next
		}
	}

	const envKey = process.env.OPENAI_API_KEY;
	if (envKey) return { provider: "openai", apiKey: envKey, model: "gpt-4o" };
	return undefined;
}

/** Check whether OpenAI web_search auth is available. */
export async function isOpenAISearchAvailable(ctx: ExtensionContext): Promise<boolean> {
	return !!(await resolveOpenAIAuth(ctx));
}

function isCodexJwt(token: string): boolean {
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	try {
		return !!JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf8"))?.[
			"https://api.openai.com/auth"
		];
	} catch {
		return false;
	}
}

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const id = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf8"))?.[
			"https://api.openai.com/auth"
		]?.chatgpt_account_id;
		return typeof id === "string" && id.trim() ? id.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function parseSSEResponse(response: Response): Promise<any> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// Not valid JSON — try SSE
		}
	}

	const outputItems: any[] = [];
	let completedResponse: any | null = null;

	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = JSON.parse(data);
			if (parsed.type === "response.output_item.done" && parsed.item) {
				outputItems.push(parsed.item);
			}
			if (parsed.type === "response.done" || parsed.type === "response.completed") {
				completedResponse = parsed.response ?? parsed;
			}
		} catch {
			// Continue
		}
	}

	if (completedResponse) {
		const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
		if (output.length > 0) return completedResponse;
		return { ...completedResponse, output: outputItems };
	}

	if (outputItems.length > 0) {
		return { output: outputItems };
	}

	throw new Error("Failed to parse OpenAI SSE response");
}

function extractSearchResults(responseObj: any): SearchResult[] {
	const output = responseObj?.output;
	if (!Array.isArray(output)) return [];

	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();

	// Extract from url_citation annotations
	for (const item of output) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			for (const ann of part.annotations ?? []) {
				if (ann.type !== "url_citation" || !ann.url) continue;
				const url = ann.url.replace(/\?utm_source=openai$/, "");
				if (seenUrls.has(url)) continue;
				seenUrls.add(url);
				const snippet = extractSnippetAround(part.text ?? "", ann.start_index, ann.end_index);
				results.push({ title: ann.title ?? url, url, snippet });
			}
		}
	}

	// Backfill from web_search_call sources
	for (const item of output) {
		if (item.type !== "web_search_call") continue;
		for (const source of item.action?.sources ?? []) {
			if (!source.url) continue;
			const url = source.url.replace(/\?utm_source=openai$/, "");
			if (seenUrls.has(url)) continue;
			seenUrls.add(url);
			results.push({ title: source.title ?? url, url, snippet: "" });
		}
	}

	return results;
}

function extractSnippetAround(
	text: string,
	start?: number,
	end?: number,
): string {
	if (start == null || end == null || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	let snippet = text.slice(before, after).trim();
	snippet = snippet.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	if (snippet.length > 300) snippet = snippet.slice(0, 297) + "...";
	return snippet;
}

/** Search using OpenAI's Responses API with the web_search tool. */
export async function searchWithOpenAI(
	query: string,
	ctx: ExtensionContext,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const auth = await resolveOpenAIAuth(ctx);
	if (!auth) {
		throw new Error(
			"OpenAI web search unavailable. Either:\n" +
			"  1. Use /login to sign in with a Codex subscription\n" +
			"  2. Set OPENAI_API_KEY in ~/.pi/web-search.json or as an env var",
		);
	}

	const activityId = activityMonitor.logStart({ type: "api", query });

	const isOAuth = isCodexJwt(auth.apiKey);
	const body = {
		model: auth.model,
		instructions: "Perform the web search. Return a brief summary mentioning each source.",
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [{ type: "web_search" }],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "auto" as const,
		parallel_tool_calls: true,
	};

	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.apiKey}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
	};

	let url: string;
	if (isOAuth) {
		url = "https://chatgpt.com/backend-api/codex/responses";
		const accountId = extractAccountId(auth.apiKey);
		if (accountId) headers["chatgpt-account-id"] = accountId;
		headers["originator"] = "pi";
	} else {
		url = "https://api.openai.com/v1/responses";
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
				: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			const errorText = await response.text();
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const responseObj = await parseSSEResponse(response);
		activityMonitor.logComplete(activityId, 200);

		const results = extractSearchResults(responseObj);

		// Extract synthesized answer from message content
		const answer = (responseObj.output ?? [])
			.filter((item: any) => item.type === "message")
			.flatMap((item: any) => item.content ?? [])
			.filter((part: any) => part.type === "output_text")
			.map((part: any) => part.text ?? "")
			.join("\n");

		return { answer: answer || "Search completed", results };
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