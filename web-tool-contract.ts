// Host-neutral contract for the web tools. The Pi extension (index.ts) and the
// MCP server (mcp-server.ts) both drive tools through WebToolCore so tool
// behavior lives in one place; each host keeps its own schemas and transport.

import type { FindMode } from "./content-find.ts";
import type { RecencyFilter } from "./source-check.ts";

export type WebToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface WebToolResult {
	content: WebToolContent[];
	details: Record<string, unknown>;
	isError?: boolean;
}

export interface WebSearchCallParams {
	query?: string;
	queries?: string[];
	numResults?: number;
	includeContent?: boolean;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	category?: string;
	provider?: string | string[];
	proxy?: string;
}

export interface FetchContentCallParams {
	url?: string;
	urls?: string[];
	mode?: string;
	forceClone?: boolean;
	proxy?: string;
}

export interface GetSearchContentCallParams {
	responseId: string;
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
	offset?: number;
	limit?: number;
	findText?: string | string[];
	findMode?: FindMode;
}

export interface SourceCheckCallParams {
	claim: string;
	queries?: string[];
	numResults?: number;
	fetchContent?: boolean;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	provider?: string | string[];
	proxy?: string;
}

export interface WebToolCore {
	webSearch(params: WebSearchCallParams, signal?: AbortSignal): Promise<WebToolResult>;
	fetchContent(params: FetchContentCallParams, signal?: AbortSignal): Promise<WebToolResult>;
	getSearchContent(params: GetSearchContentCallParams, signal?: AbortSignal): Promise<WebToolResult>;
	sourceCheck(params: SourceCheckCallParams, signal?: AbortSignal): Promise<WebToolResult>;
}
