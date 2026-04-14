import { hasExaApiKey, searchWithExa, searchWithExaMcp } from "./exa.js";

const DEFAULT_MAX_TOKENS = 5000;
const MIN_OUTPUT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 120000;

function buildCodeSearchQuery(query: string): string {
	return [
		query,
		"Prefer official documentation, GitHub repositories, Stack Overflow answers, and pages with concrete code examples.",
		"Prioritize copyable snippets, API references, migration notes, and version-specific implementation details.",
		"Ignore generic marketing pages unless they contain the clearest technical explanation.",
	].join("\n");
}

function getNumResults(maxTokens: number): number {
	if (maxTokens >= 20000) return 10;
	if (maxTokens >= 10000) return 8;
	return 6;
}

function getMaxOutputChars(maxTokens: number): number {
	return Math.max(MIN_OUTPUT_CHARS, Math.min(MAX_OUTPUT_CHARS, maxTokens * 4));
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncated = text.slice(0, Math.max(0, maxChars - 18)).trimEnd();
	return `${truncated}\n\n[truncated ...]`;
}

function buildSourcesSection(results: Array<{ title: string; url: string }>): string {
	if (results.length === 0) return "";
	return [
		"Sources:",
		...results.map((result, index) => `${index + 1}. ${result.title} — ${result.url}`),
	].join("\n");
}

function formatCodeSearchText(
	answer: string,
	results: Array<{ title: string; url: string }>,
	maxTokens: number,
): string {
	const sections: string[] = [];
	const trimmedAnswer = answer.trim();
	if (trimmedAnswer) sections.push(trimmedAnswer);

	const sourcesSection = buildSourcesSection(results.slice(0, 10));
	if (sourcesSection) sections.push(sourcesSection);

	const combined = sections.join("\n\n").trim();
	if (!combined) {
		return "No relevant code examples or documentation found. Try a more specific query with the library, framework, version, language, or exact API name.";
	}

	return truncateText(combined, getMaxOutputChars(maxTokens));
}

export async function executeCodeSearch(
	_toolCallId: string,
	params: { query: string; maxTokens?: number },
	signal?: AbortSignal,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { query: string; maxTokens: number; error?: string; searchMode?: string };
}> {
	const query = params.query.trim();
	if (!query) {
		return {
			content: [{ type: "text", text: "Error: No query provided." }],
			details: { query: "", maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS, error: "No query provided" },
		};
	}

	const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
	const numResults = getNumResults(maxTokens);
	const searchQuery = buildCodeSearchQuery(query);
	const usesApiKey = hasExaApiKey();

	try {
		const result = await searchWithExa(searchQuery, { numResults, signal });
		const fallbackToMcp = !!(result && "exhausted" in result);
		const resolvedSearch = fallbackToMcp
			? await searchWithExaMcp(searchQuery, { numResults, signal })
			: result;
		const resolved = resolvedSearch && !("exhausted" in resolvedSearch) ? resolvedSearch : null;
		const searchMode = !usesApiKey || fallbackToMcp ? "exa-web-search-mcp" : "exa-web-search-api";

		const text = formatCodeSearchText(resolved?.answer ?? "", resolved?.results ?? [], maxTokens);
		return {
			content: [{ type: "text", text }],
			details: {
				query,
				maxTokens,
				searchMode,
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			throw err;
		}
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: { query, maxTokens, error: message, searchMode: usesApiKey ? "exa-web-search-api" : "exa-web-search-mcp" },
		};
	}
}
