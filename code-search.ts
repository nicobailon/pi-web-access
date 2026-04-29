import { activityMonitor } from "./activity.js";
import { callExaMcp } from "./exa.js";

const CODE_CONTEXT_TOOL = "get_code_context_exa";
const WEB_SEARCH_TOOL = "web_search_exa";
const DEFAULT_MAX_TOKENS = 5000;

let codeContextToolMissing = false;

function isMissingMcpToolError(message: string): boolean {
	const normalized = message.toLowerCase();
	return normalized.includes("tool") && normalized.includes("not found");
}

function buildFallbackQuery(query: string): string {
	const normalized = query.toLowerCase();
	const hasCodeSearchTerms = /\b(api|code|docs?|documentation|example|github|implementation|library|source|stackoverflow|stack overflow)\b/
		.test(normalized);
	return hasCodeSearchTerms ? query : `${query} code examples documentation GitHub Stack Overflow official docs`;
}

function maxTokensToResultCount(maxTokens: number): number {
	return Math.min(20, Math.max(5, Math.ceil(maxTokens / 1000)));
}

function trimApproxTokens(text: string, maxTokens: number): string {
	const maxCharacters = Math.max(1000, maxTokens * 4);
	if (text.length <= maxCharacters) return text;
	return `${text.slice(0, maxCharacters).trimEnd()}\n\n[Truncated by code_search to approximately ${maxTokens} tokens.]`;
}

async function executeFallbackSearch(query: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
	const text = await callExaMcp(
		WEB_SEARCH_TOOL,
		{
			query: buildFallbackQuery(query),
			numResults: maxTokensToResultCount(maxTokens),
		},
		signal,
	);
	return trimApproxTokens(text, maxTokens);
}

export async function executeCodeSearch(
	_toolCallId: string,
	params: { query: string; maxTokens?: number },
	signal?: AbortSignal,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { query: string; maxTokens: number; error?: string; mode?: "code-context" | "web-search-fallback" };
}> {
	const query = params.query.trim();
	if (!query) {
		return {
			content: [{ type: "text", text: "Error: No query provided." }],
			details: { query: "", maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS, error: "No query provided" },
		};
	}

	const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		let mode: "code-context" | "web-search-fallback" = "web-search-fallback";
		let text: string;

		if (codeContextToolMissing) {
			text = await executeFallbackSearch(query, maxTokens, signal);
		} else {
			try {
				text = await callExaMcp(
					CODE_CONTEXT_TOOL,
					{
						query,
						tokensNum: maxTokens,
					},
					signal,
				);
				mode = "code-context";
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!isMissingMcpToolError(message)) throw err;
				codeContextToolMissing = true;
				text = await executeFallbackSearch(query, maxTokens, signal);
			}
		}

		activityMonitor.logComplete(activityId, 200);
		return {
			content: [{ type: "text", text }],
			details: { query, maxTokens, mode },
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
			throw err;
		}
		activityMonitor.logError(activityId, message);
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: { query, maxTokens, error: message },
		};
	}
}
