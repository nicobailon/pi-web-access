// MCP server exposing the web tools over any transport. Tool behavior lives in
// the WebToolCore; this module only lists tools, validates arguments at the
// boundary, forwards cancellation, and maps results to MCP content.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOL_DEFINITIONS, validateMcpToolArguments } from "./mcp-tool-definitions.ts";
import type {
	FetchContentCallParams,
	GetSearchContentCallParams,
	SourceCheckCallParams,
	WebSearchCallParams,
	WebToolCore,
	WebToolResult,
} from "./web-tool-contract.ts";

export interface McpServerInfo {
	name: string;
	version: string;
}

type ToolRunner = (core: WebToolCore, args: Record<string, unknown>, signal: AbortSignal) => Promise<WebToolResult>;
type ToolInputSchema = { type: "object"; [key: string]: unknown };

// Arguments are validated against the matching MCP schema before these casts run.
const TOOL_RUNNERS: Record<string, ToolRunner> = {
	web_search: (core, args, signal) => core.webSearch(args as WebSearchCallParams, signal),
	fetch_content: (core, args, signal) => core.fetchContent(args as FetchContentCallParams, signal),
	get_search_content: (core, args, signal) => core.getSearchContent(args as unknown as GetSearchContentCallParams, signal),
	source_check: (core, args, signal) => core.sourceCheck(args as unknown as SourceCheckCallParams, signal),
};

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function toCallToolResult(result: WebToolResult): CallToolResult {
	return { content: result.content, structuredContent: result.details, ...(result.isError && { isError: true }) };
}

/** Serves the tools named in enabledTools (default: all four MCP tools). */
export function createMcpServer(core: WebToolCore, info: McpServerInfo, enabledTools?: readonly string[]): Server {
	const server = new Server(info, { capabilities: { tools: {} } });
	const tools = enabledTools ? MCP_TOOL_DEFINITIONS.filter((tool) => enabledTools.includes(tool.name)) : MCP_TOOL_DEFINITIONS;

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as ToolInputSchema,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name } = request.params;
		const tool = tools.find((candidate) => candidate.name === name);
		const run = TOOL_RUNNERS[name];
		if (!tool || !run) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

		const args = request.params.arguments ?? {};
		const problems = validateMcpToolArguments(tool, args);
		if (problems.length > 0) return errorResult(`Invalid arguments for ${name}:\n- ${problems.join("\n- ")}`);

		try {
			return toCallToolResult(await run(core, args, extra.signal));
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	});

	return server;
}
