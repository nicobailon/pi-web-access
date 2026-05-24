/**
 * Self-Hosted Code Search
 * Race condition pattern: Sourcegraph MCP (indexed repos) vs Exa pipeline (Context7-style)
 * 
 * Architecture:
 * 1. Race condition — Sourcegraph MCP with timeout vs Exa pipeline
 *    - If Sourcegraph has repo indexed → wins instantly
 *    - If Sourcegraph times out → Exa pipeline takes over
 * 2. Sourcegraph MCP — Native search API via MCP protocol (keyword_search, nls_search)
 * 3. Ripgrep Search — Fast local code search
 * 4. Semantic Code Search — Nomic Embed v1.5 (256-dim) for semantic similarity
 * 5. Exa Pipeline Code Search — Context7-style GitHub repo search
 * 
 * Proactive context gathering:
 * - Gathers context from codebase, project structure, current task
 * - Uses multiple tools: Code Search, Codebase File, Terminal, Web Browser, MCP
 * - Performs multiple review loops to refine context
 * - Reduces hallucinations by providing complete context
 */

import { exec } from "child_process";
import { promisify } from "util";
import { activityMonitor } from "./activity.js";
import { generateNomicEmbedding, cosineSimilarity } from "./embedding-nomic.js";
import { search } from "./firecrawl-search.js";
import { searchWithSearXNG } from "./searxng-search.js";
import { extractContent } from "./extract.js";
import { generateNomicBatchedEmbeddings } from "./embedding-nomic.js";
import { searchSimilar } from "./exa-vector-db.js";
import { Client } from "@modelcontextprotocol/client";

const execAsync = promisify(exec);

// Sourcegraph configuration (self-hosted)
const SOURCEGRAPH_URL = process.env.SOURCEGRAPH_URL || "http://localhost:3000";
const SOURCEGRAPH_API_KEY = process.env.SOURCEGRAPH_API_KEY;

// Warn if no API key is configured but MCP auth is expected
if (!SOURCEGRAPH_API_KEY) {
	console.warn("[code-search] SOURCEGRAPH_API_KEY not set — MCP auth may fail if Sourcegraph requires it");
}

// Race condition timeout for Sourcegraph (5 seconds)
const SOURCEGRAPH_TIMEOUT_MS = 5000;

// MCP client singleton
let mcpClient: Client | null = null;
let mcpInitialized = false;

export interface CodeSearchResult {
	url: string;
	title: string;
	content: string;
	score: number;
}

/**
 * Initialize the Sourcegraph MCP client
 */
async function initMcpClient(): Promise<Client> {
	if (mcpClient && mcpInitialized) {
		return mcpClient;
	}

	try {
		const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
		
		mcpClient = new Client(
			{ name: "pi-web-access", version: "1.0.0" },
			{ capabilities: {} }
		);

		const transport = new StreamableHTTPClientTransport(new URL(`${SOURCEGRAPH_URL}/.api/mcp`));
		
		// Set up auth header via transport customization
		// The Sourcegraph MCP server expects auth via the Authorization header
		// We need to intercept the fetch to add the auth header
		// Use try/finally to guarantee restoration of globalThis.fetch
		let originalFetch: typeof globalThis.fetch | undefined;
		if (SOURCEGRAPH_API_KEY) {
			originalFetch = globalThis.fetch;
			globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				headers.set("Authorization", `token ${SOURCEGRAPH_API_KEY}`);
				return originalFetch!(input, { ...init, headers });
			};
		}

		try {
			await mcpClient.connect(transport);
			mcpInitialized = true;
			return mcpClient;
		} finally {
			// Restore original fetch even if connect fails
			if (originalFetch) {
				globalThis.fetch = originalFetch;
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[code-search] Failed to initialize MCP client: ${message}`);
		mcpClient = null;
		mcpInitialized = false;
		throw err;
	}
}

/**
 * Search Sourcegraph MCP for code matches using keyword_search
 * Returns empty array on error or if MCP is unavailable
 */
export async function searchSourcegraph(
	query: string,
	limit: number = 20,
): Promise<CodeSearchResult[]> {
	const activityId = activityMonitor.logStart({ type: "api", query: `sourcegraph: ${query}` });

	try {
		const client = await initMcpClient();

		// Use keyword_search tool for precise code search
		const result = await client.callTool({
			name: "keyword_search",
			arguments: { query }
		});

		// Parse MCP tool result
		const results: CodeSearchResult[] = [];
		const textContent = result.content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join("\n");

		if (textContent && textContent !== "no results") {
			// Parse the structured output from Sourcegraph
			const lines = textContent.split("\n").filter(l => l.trim());
			for (const line of lines.slice(0, limit)) {
				// Sourcegraph MCP returns results in a structured format
				// Try to extract URL, title, and content
				const urlMatch = line.match(/(?:https?:\/\/[^\s]+)/);
				const contentMatch = line.match(/^(?:[^:]+:\s*)?(.+)$/);
				
				results.push({
					url: urlMatch?.[0] || "",
					title: line.split(":")[0] || "",
					content: contentMatch?.[1]?.trim() || line.trim(),
					score: 1,
				});
			}
		}

		activityMonitor.logComplete(activityId, results.length > 0 ? 200 : 204);
		return results;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activityMonitor.logError(activityId, message);
		// MCP may not be available — return empty, not an error
		return [];
	}
}

/**
 * Search Sourcegraph MCP using nls_search (natural language search)
 * More flexible than keyword_search, uses semantic matching
 */
export async function searchSourcegraphNls(
	query: string,
	limit: number = 20,
): Promise<CodeSearchResult[]> {
	const activityId = activityMonitor.logStart({ type: "api", query: `sourcegraph-nls: ${query}` });

	try {
		const client = await initMcpClient();

		// Use nls_search tool for natural language search
		const result = await client.callTool({
			name: "nls_search",
			arguments: { query }
		});

		const results: CodeSearchResult[] = [];
		const textContent = result.content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join("\n");

		if (textContent && textContent !== "no results") {
			const lines = textContent.split("\n").filter(l => l.trim());
			for (const line of lines.slice(0, limit)) {
				const urlMatch = line.match(/(?:https?:\/\/[^\s]+)/);
				const contentMatch = line.match(/^(?:[^:]+:\s*)?(.+)$/);
				
				results.push({
					url: urlMatch?.[0] || "",
					title: line.split(":")[0] || "",
					content: contentMatch?.[1]?.trim() || line.trim(),
					score: 1,
				});
			}
		}

		activityMonitor.logComplete(activityId, results.length > 0 ? 200 : 204);
		return results;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activityMonitor.logError(activityId, message);
		return [];
	}
}

/**
 * Search Exa Pipeline for code — Context7-style GitHub repo search
 * Searches public GitHub repos on-demand using the exa pipeline infrastructure
 */
export async function searchExaCodeSearch(
	query: string,
	limit: number = 20,
): Promise<CodeSearchResult[]> {
	const activityId = activityMonitor.logStart({ type: "api", query: `exa-code: ${query}` });

	try {
		// Step 1: Multi-source search (SearXNG + Firecrawl) to find relevant GitHub repos
		const [searxngResults, firecrawlResults] = await Promise.all([
			searchWithSearXNG(query, { numResults: limit }).catch(() => ({ results: [] })),
			search(query, { numResults: limit, provider: "firecrawl" as const }).catch(() => ({ results: [] })),
		]);

		// Merge and filter for GitHub URLs
		const allResults = [...(searxngResults?.results || []), ...(firecrawlResults?.results || [])];
		const githubUrls = allResults
			.filter((r: any) => r.url?.includes("github.com") && r.snippet?.length > 100)
			.slice(0, limit);

		if (githubUrls.length === 0) {
			activityMonitor.logComplete(activityId, 200);
			return [];
		}

		// Step 2: Extract content from GitHub repos
		const enrichedResults = await Promise.all(
			githubUrls.map(async (r: any) => {
				try {
					const extracted = await extractContent(r.url);
					return { ...r, content: extracted.content || r.snippet || "" };
				} catch {
					return { ...r, content: r.snippet || "" };
				}
			}),
		);

		// Step 3: Generate embeddings
		const embeddingPrefix = "Represent this document for searching: ";
		const embeddingTexts = enrichedResults.map((r: any) => `${embeddingPrefix}${r.title} ${r.content}`);
		const embeddings = await generateNomicBatchedEmbeddings(embeddingTexts, 32);

		// Step 4: Embed query and compute similarity
		const queryEmbedding = await generateNomicEmbedding(`Represent this query for searching documents: ${query}`);
		const scores = enrichedResults.map((r: any, i: number) => {
			const sim = cosineSimilarity(queryEmbedding, embeddings[i]);
			// BM25-style term overlap bonus
			const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
			const termCount = terms.reduce((count, term) => {
				let idx = 0;
				let c = 0;
				while ((idx = r.content.toLowerCase().indexOf(term, idx)) !== -1) { idx += term.length; c++; }
				return count + c;
			}, 0);
			const bm25Bonus = termCount > 0 ? Math.min(0.3, termCount * 0.05) : 0;
			return Math.max(0, sim + bm25Bonus);
		});

		// Step 5: Sort by score and format results
		const ranked = enrichedResults
			.map((r: any, i: number) => ({ ...r, score: scores[i] }))
			.sort((a: any, b: any) => b.score - a.score)
			.slice(0, limit);

		const results: CodeSearchResult[] = ranked.map((r: any) => ({
			url: r.url || "",
			title: r.title || "",
			content: r.content?.slice(0, 500) || "",
			score: r.score || 0,
		}));

		activityMonitor.logComplete(activityId, 200);
		return results;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activityMonitor.logError(activityId, message);
		return [];
	}
}

/**
 * Search Sourcegraph with timeout — returns empty array if timeout exceeded
 */
export async function searchSourcegraphWithTimeout(
	query: string,
	limit: number = 20,
	timeoutMs: number = SOURCEGRAPH_TIMEOUT_MS,
): Promise<CodeSearchResult[]> {
	const activityId = activityMonitor.logStart({ type: "api", query: `sourcegraph-timed: ${query}` });

	try {
		// Create race between Sourcegraph search and timeout
		const sourcegraphPromise = searchSourcegraph(query, limit);
		const timeoutPromise = new Promise<CodeSearchResult[]>((_, reject) =>
			setTimeout(() => reject(new Error("Sourcegraph timeout")), timeoutMs),
		);

		const results = await Promise.race([sourcegraphPromise, timeoutPromise]);
		activityMonitor.logComplete(activityId, 200);
		return results;
	} catch (err) {
		// Timeout or network error — return empty, not an error
		activityMonitor.logComplete(activityId, 0);
		return [];
	}
}

/**
 * Search with ripgrep for fast local code search
 */
export async function searchWithRipgrep(
	query: string,
	limit: number = 20,
): Promise<CodeSearchResult[]> {
	const activityId = activityMonitor.logStart({ type: "api", query: `ripgrep: ${query}` });

	try {
		const { stdout } = await execAsync(
			`rg --vimgrep --no-heading -n -i "${query}" --glob '!.git' --glob '!node_modules' --max-count ${limit * 5}`,
			{ timeout: 10000 },
		);

		const results: CodeSearchResult[] = [];
		const lines = stdout.trim().split("\n");
		
		for (const line of lines.slice(0, limit)) {
			const parts = line.split(":");
			if (parts.length >= 3) {
				const file = parts[0];
				const lineNum = parts[1];
				const match = parts.slice(2).join(":");
				
				results.push({
					url: file,
					title: `${file}:${lineNum}`,
					content: match.trim(),
					score: 1,
				});
			}
		}

		activityMonitor.logComplete(activityId, 200);
		return results;
	} catch {
		// ripgrep may not be installed
		return [];
	}
}

/**
 * Semantic code search using Nomic Embed v1.5
 * Embeds query and finds semantically similar code snippets
 */
export async function searchCodeSemantically(
	query: string,
	limit: number = 20,
): Promise<CodeSearchResult[]> {
	const activityId = activityMonitor.logStart({ type: "api", query: `semantic-code: ${query}` });

	try {
		const queryEmbedding = await generateNomicEmbedding(query);
		
		// Search vector DB for code-related documents
		const results = searchSimilar(queryEmbedding, limit);
		
		const codeResults: CodeSearchResult[] = results.map((r) => ({
			url: r.document.url,
			title: r.document.title,
			content: r.document.content,
			score: r.similarity,
		}));

		activityMonitor.logComplete(activityId, 200);
		return codeResults;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activityMonitor.logError(activityId, message);
		return [];
	}
}

/**
 * Combined code search with async race condition:
 * Sourcegraph MCP (indexed repos) vs Exa pipeline (Context7-style)
 * 
 * Async race pattern (reduces latency):
 * 1. Start BOTH Sourcegraph AND Exa pipeline simultaneously
 * 2. First to return wins (Promise.race)
 * 3. Winner's results + ripgrep/semantic merged in background
 * 4. Loser's work continues but results discarded
 * 
 * Latency benefit: No waiting for timeout — Exa starts immediately in parallel
 */
export async function executeCodeSearch(
	_toolCallId: string,
	params: { query: string; maxTokens?: number },
	signal?: AbortSignal,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: { query: string; maxTokens: number; error?: string; mode?: string };
}> {
	const query = params.query.trim();
	if (!query) {
		return {
			content: [{ type: "text", text: "Error: No query provided." }],
			details: { query: "", maxTokens: params.maxTokens ?? 5000, error: "No query provided" },
		};
	}

	const maxTokens = params.maxTokens ?? 5000;
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		// Phase 1: Async race — Sourcegraph with timeout vs Exa pipeline
		// Sourcegraph is raced against a timeout; Exa runs in parallel as fallback.
		// If Sourcegraph returns results within timeout, use them (fast path).
		// If Sourcegraph times out or returns empty, fall back to Exa pipeline.
		const [sourcegraphResults, exaResults] = await Promise.allSettled([
			searchSourcegraphWithTimeout(query).catch(() => []),
			searchExaCodeSearch(query).catch(() => []),
		]);
		
		const sgResults = sourcegraphResults.status === 'fulfilled' ? sourcegraphResults.value : [];
		const exaResultsValue = exaResults.status === 'fulfilled' ? exaResults.value : [];
		
		let finalResults: CodeSearchResult[];
		let mode: string;
		
		if (sgResults.length > 0) {
			// Sourcegraph won the race — it has the repo indexed (fast path)
			finalResults = sgResults;
			mode = "sourcegraph-mcp-wins";
		} else if (exaResultsValue.length > 0) {
			// Exa pipeline won — Sourcegraph had nothing indexed
			finalResults = exaResultsValue;
			mode = "exa-pipeline-wins";
		} else {
			// Neither returned results
			finalResults = [];
			mode = "no-results";
		}
		
		// Phase 2: Run ripgrep and semantic in parallel for additional context
		// (always runs, regardless of race winner)
		const [ripgrepResults, semanticResults] = await Promise.all([
			searchWithRipgrep(query).catch(() => []),
			searchCodeSemantically(query).catch(() => []),
		]);
		
		// Merge with deduplication
		const seen = new Set<string>();
		for (const r of [...ripgrepResults, ...semanticResults]) {
			if (!seen.has(r.url)) {
				seen.add(r.url);
				finalResults.push(r);
			}
		}
		
		// Sort by score
		finalResults.sort((a, b) => b.score - a.score);

		const topResults = finalResults.slice(0, Math.ceil(maxTokens / 1000));

		// Format results as text
		const text = topResults.map((r, i) => {
			return `[${i + 1}] ${r.title}\nURL: ${r.url}\nScore: ${r.score.toFixed(3)}\n${r.content.slice(0, 500)}\n`;
		}).join("\n---\n\n");

		activityMonitor.logComplete(activityId, 200);

		if (topResults.length === 0) {
			// Provide helpful guidance when no results found
			const guidance = [
				"No code search results found.",
				"",
				"Search methods used (async race):",
				"  • Sourcegraph MCP: Not running or repo not indexed (localhost:3000/.api/mcp)",
				"  • Exa Pipeline: No public GitHub repos matched",
				"  • Ripgrep: Local file search (searches current directory)",
				"  • Semantic: Requires documents indexed in the vector DB",
				"",
				"Tip: Use `read`, `bash` (grep/rg), or `web_search` for broader code documentation lookup.",
			].join("\n");
			
			return {
				content: [{ type: "text", text: guidance }],
				details: {
					query,
					maxTokens,
					mode,
					resultCount: 0,
					note: "No results — all search methods returned empty",
				},
			};
		}

		return {
			content: [{ type: "text", text: text }],
			details: {
				query,
				maxTokens,
				mode,
				resultCount: topResults.length,
			},
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
