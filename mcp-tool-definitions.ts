// MCP-only tool definitions: names, descriptions, and input schemas for the
// standalone MCP server. Deliberately independent of the Pi tool schemas in
// index.ts so MCP changes never touch Pi's provider-facing definitions.
// Pi-only parameters (workflow/curator, prompt, answerModel, timestamp, frames,
// model, auth) are not exposed; unknown properties are rejected.

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { RESOLVED_SEARCH_PROVIDERS } from "./gemini-search.ts";

function stringEnum(values: readonly string[], description: string) {
	return Type.Unsafe<string>({ type: "string", enum: [...values], description });
}

// Kimi authenticates only through Pi's login, so it is never offered here.
const MCP_SEARCH_PROVIDERS = RESOLVED_SEARCH_PROVIDERS.filter((provider) => provider !== "kimi");

const providerSchema = Type.Union([
	stringEnum(["auto", "all", ...MCP_SEARCH_PROVIDERS], "Single provider."),
	Type.Array(stringEnum(MCP_SEARCH_PROVIDERS, "Provider."), { minItems: 1 }),
], { description: "Search provider, or a non-empty list of providers to search simultaneously. Omit or use auto for the configured provider; all searches every eligible provider. Providers without credentials return an error." });

const recencySchema = stringEnum(["day", "week", "month", "year"], "Filter results by recency.");
const domainFilterSchema = Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude." });
const numResultsSchema = Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)." });
const proxySchema = Type.String({ description: "http(s) or socks proxy URL for this call's outbound requests; empty string forces direct access." });
// Page fetches write a page cache and clone GitHub URLs into a temp directory,
// including the fetches behind includeContent and fetchContent.
const fetchingAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: TSchema;
	annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint: boolean };
}

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
	{
		name: "web_search",
		description: "Search the web and return bounded, source-linked results or provider answers. Full results are stored for retrieval with get_search_content using the returned responseId.",
		inputSchema: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched concurrently; vary angles for broader coverage." })),
			numResults: Type.Optional(numResultsSchema),
			includeContent: Type.Optional(Type.Boolean({ description: "Also fetch full page content for the results, retrievable with get_search_content." })),
			recencyFilter: Type.Optional(recencySchema),
			domainFilter: Type.Optional(domainFilterSchema),
			category: Type.Optional(Type.String({ description: "Exa only: result category, e.g. news, research paper." })),
			provider: Type.Optional(providerSchema),
			proxy: Type.Optional(proxySchema),
		}, { additionalProperties: false }),
		annotations: fetchingAnnotations,
	},
	{
		name: "fetch_content",
		description: "Fetch URL(s) and return bounded content. Supports web pages, GitHub repositories, and PDFs. Full content is stored for retrieval with get_search_content using the returned responseId.",
		inputSchema: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs fetched in parallel." })),
			mode: Type.Optional(stringEnum(["readable", "raw"], "readable = extract readable content as markdown (default); raw = return the exact textual body using direct HTTP only.")),
			forceClone: Type.Optional(Type.Boolean({ description: "Force cloning GitHub repositories that exceed the size threshold." })),
			proxy: Type.Optional(proxySchema),
		}, { additionalProperties: false }),
		annotations: fetchingAnnotations,
	},
	{
		name: "get_search_content",
		description: "Retrieve bounded pages of stored search results or fetched content from a previous web_search, fetch_content, or source_check call, or find matching passages with findText.",
		inputSchema: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search, fetch_content, or source_check." }),
			query: Type.Optional(Type.String({ description: "Select stored results for this search query." })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Select stored results for the query at this index." })),
			url: Type.Optional(Type.String({ description: "Select stored content for this URL." })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Select stored content for the URL at this index." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into the stored content (default 0). Ignored when findText is supplied." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum characters to return. Ignored when findText is supplied." })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Text or texts to find in the selected stored content." })),
			findMode: Type.Optional(stringEnum(["exact", "case-insensitive", "fuzzy"], "Matching mode for findText (default: case-insensitive).")),
		}, { additionalProperties: false }),
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "source_check",
		description: "Gather web sources for a claim and return a bounded machine-readable research artifact with exact passage citations for manual review.",
		inputSchema: Type.Object({
			claim: Type.String({ description: "The assertion to gather web sources for." }),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Search queries (default: the claim)." })),
			numResults: Type.Optional(numResultsSchema),
			fetchContent: Type.Optional(Type.Boolean({ description: "Fetch up to 5 result pages for exact passage extraction." })),
			recencyFilter: Type.Optional(recencySchema),
			domainFilter: Type.Optional(domainFilterSchema),
			provider: Type.Optional(providerSchema),
			proxy: Type.Optional(proxySchema),
		}, { additionalProperties: false }),
		annotations: fetchingAnnotations,
	},
];

/** Returns human-readable validation problems; an empty array means the arguments are valid. */
export function validateMcpToolArguments(tool: McpToolDefinition, args: unknown): string[] {
	if (Value.Check(tool.inputSchema, args)) return [];
	const problems = new Set<string>();
	for (const error of Value.Errors(tool.inputSchema, args)) {
		// additionalProperties also reports a per-property "schema is false"; the summary below names the property.
		if (error.keyword === "boolean") continue;
		const path = error.instancePath || "arguments";
		const unknown = error.keyword === "additionalProperties"
			? (error.params as { additionalProperties?: string[] }).additionalProperties
			: undefined;
		problems.add(unknown?.length ? `${path}: unknown properties ${unknown.join(", ")}` : `${path}: ${error.message}`);
	}
	return problems.size > 0 ? [...problems] : ["arguments do not match the input schema"];
}
