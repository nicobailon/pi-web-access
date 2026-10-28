// MCP-only tool definitions: names, descriptions, and input schemas for the
// standalone MCP server. Deliberately independent of the Pi tool schemas in
// index.ts so MCP changes never touch Pi's provider-facing definitions.
// Pi-only parameters (workflow/curator, prompt, answerModel, timestamp, frames,
// model, auth) are not exposed; unknown properties are rejected.

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { RESOLVED_SEARCH_PROVIDERS } from "./gemini-search.ts";

function stringEnum(values: readonly string[], description?: string) {
	return Type.Unsafe<string>({ type: "string", enum: [...values], ...(description && { description }) });
}

// Kimi authenticates only through Pi's login, so it is never offered here.
const MCP_SEARCH_PROVIDERS = RESOLVED_SEARCH_PROVIDERS.filter((provider) => provider !== "kimi");

// Names are checked in validateMcpToolArguments instead of listed in the schema: the
// provider enum, written for both the single and list forms, was ~1,060 characters per tool.
const providerSchema = Type.Union([
	Type.String(),
	Type.Array(Type.String(), { minItems: 1 }),
], { description: "auto, all, a name, or a list of names searched together; omit for the configured default." });
const PROVIDER_CHOICES = `Use auto, all, or one or more of: ${MCP_SEARCH_PROVIDERS.join(", ")}.`;

function providerProblem(value: unknown): string | undefined {
	const invalid = typeof value === "string"
		? (value === "auto" || value === "all" || MCP_SEARCH_PROVIDERS.includes(value as never) ? [] : [value])
		: Array.isArray(value) ? value.filter((name) => !MCP_SEARCH_PROVIDERS.includes(name)) : [];
	if (invalid.length === 0) return undefined;
	return `/provider: unknown provider ${invalid.map((name) => JSON.stringify(name)).join(", ")}. ${PROVIDER_CHOICES}`;
}

const recencySchema = stringEnum(["day", "week", "month", "year"]);
const domainFilterSchema = Type.Array(Type.String(), { description: "Prefix - to exclude" });
const numResultsSchema = Type.Integer({ minimum: 1, maximum: 20, description: "Default 5" });
const proxySchema = Type.String({ description: "http(s) or socks proxy URL; \"\" forces direct" });
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
		description: "Search the web for sources or answers. Full results are stored for retrieval with get_search_content by responseId. Prefer 2-4 varied queries.",
		inputSchema: Type.Object({
			query: Type.Optional(Type.String()),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Run concurrently; vary the angle" })),
			numResults: Type.Optional(numResultsSchema),
			includeContent: Type.Optional(Type.Boolean({ description: "Also fetch full page content" })),
			recencyFilter: Type.Optional(recencySchema),
			domainFilter: Type.Optional(domainFilterSchema),
			category: Type.Optional(Type.String({ description: "Exa only, e.g. news" })),
			provider: Type.Optional(providerSchema),
			proxy: Type.Optional(proxySchema),
		}, { additionalProperties: false }),
		annotations: fetchingAnnotations,
	},
	{
		name: "fetch_content",
		description: "Fetch web pages, PDFs, and GitHub repos. Full content is stored for retrieval with get_search_content by responseId.",
		inputSchema: Type.Object({
			url: Type.Optional(Type.String()),
			urls: Type.Optional(Type.Array(Type.String())),
			mode: Type.Optional(stringEnum(["readable", "raw"], "readable (default): extract readable content as markdown; raw: return the exact textual body using direct HTTP only")),
			forceClone: Type.Optional(Type.Boolean({ description: "Clone GitHub repos over the size limit" })),
			proxy: Type.Optional(proxySchema),
		}, { additionalProperties: false }),
		annotations: fetchingAnnotations,
	},
	{
		name: "get_search_content",
		description: "Page through or search stored content from web_search, source_check, or fetch_content by responseId.",
		inputSchema: Type.Object({
			responseId: Type.String(),
			query: Type.Optional(Type.String()),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
			url: Type.Optional(Type.String()),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Characters, default the maximum" })),
			findText: Type.Optional(Type.Union([
				Type.String({ minLength: 1, maxLength: 500 }),
				Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
			], { description: "Find passages instead of paging" })),
			findMode: Type.Optional(stringEnum(["exact", "case-insensitive", "fuzzy"])),
		}, { additionalProperties: false }),
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "source_check",
		description: "Gather cited web passages about a claim for manual review.",
		inputSchema: Type.Object({
			claim: Type.String({ description: "Assertion to check" }),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Default: the claim" })),
			numResults: Type.Optional(numResultsSchema),
			fetchContent: Type.Optional(Type.Boolean({ description: "Fetch top 5 pages for exact passages" })),
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
	const checksProvider = (tool.inputSchema as { properties?: Record<string, unknown> }).properties?.provider !== undefined;
	const provider = checksProvider && typeof args === "object" && args !== null
		? providerProblem((args as { provider?: unknown }).provider)
		: undefined;
	if (Value.Check(tool.inputSchema, args)) return provider ? [provider] : [];
	const problems = new Set<string>();
	if (provider) problems.add(provider);
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
