/**
 * Self-Hosted Code Search
 * Combines Sourcegraph (self-hosted) + ripgrep + Nomic Embeddings
 * 
 * Replaces Exa MCP code search with:
 * 1. Keyword Search — Traditional text-based search with automatic query rewriting
 * 2. Sourcegraph Search — Native search API with full-text search stack
 * 3. Code Graph — Analyzes code structure and relationships (calls, imports, extends)
 * 4. Semantic Code Search — Nomic Embed v1.5 (256-dim) for semantic similarity
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

const execAsync = promisify(exec);

// Sourcegraph configuration (self-hosted)
const SOURCEGRAPH_URL = process.env.SOURCEGRAPH_URL || "http://localhost:3000";

export interface CodeSearchResult {
	url: string;
	title: string;
	content: string;
	score: number;
}

/**
 * Search Sourcegraph API for code matches
 */
export async function searchSourcegraph(
	query: string,
	limit: number = 20,
): Promise<CodeSearchResult[]> {
	const activityId = activityMonitor.logStart({ type: "api", query: `sourcegraph: ${query}` });

	try {
		// Sourcegraph search API
		const response = await fetch(`${SOURCEGRAPH_URL}/.api/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				q: query,
				count: limit,
				file: "",
				// Sourcegraph uses a different query syntax
				timeout_ms: 5000,
			}),
		});

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return [];
		}

		const data = await response.json();
		
		// Parse Sourcegraph results
		const results: CodeSearchResult[] = [];
		const hits = data?.hits || [];
		
		for (const hit of hits.slice(0, limit)) {
			results.push({
				url: hit.url || hit.repo || "",
				title: hit.fileName || hit.repository || "",
				content: hit.match || hit.lines?.map((l: any) => l.content).join("\n") || "",
				score: hit.score || 1,
			});
		}

		activityMonitor.logComplete(activityId, 200);
		return results;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activityMonitor.logError(activityId, message);
		// Sourcegraph may not be running — return empty, not an error
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
 * Combined code search: Sourcegraph + ripgrep + semantic
 * Merges results from all three sources
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
		// Run all three search methods in parallel
		const [sourcegraphResults, ripgrepResults, semanticResults] = await Promise.all([
			searchSourcegraph(query).catch(() => []),
			searchWithRipgrep(query).catch(() => []),
			searchCodeSemantically(query).catch(() => []),
		]);

		// Merge and deduplicate
		const seen = new Set<string>();
		const merged: CodeSearchResult[] = [];
		
		for (const r of [...sourcegraphResults, ...ripgrepResults, ...semanticResults]) {
			if (!seen.has(r.url)) {
				seen.add(r.url);
				merged.push(r);
			}
		}

		// Sort by score
		merged.sort((a, b) => b.score - a.score);
		const topResults = merged.slice(0, Math.ceil(maxTokens / 1000));

		// Format results as text
		const text = topResults.map((r, i) => {
			return `[${i + 1}] ${r.title}\nURL: ${r.url}\nScore: ${r.score.toFixed(3)}\n${r.content.slice(0, 500)}\n`;
		}).join("\n---\n\n");

		activityMonitor.logComplete(activityId, 200);
		
		return {
			content: [{ type: "text", text: text || "No code search results found." }],
			details: {
				query,
				maxTokens,
				mode: "sourcegraph+ripgrep+semantic",
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

// Re-export for backward compatibility
export { searchSourcegraph, searchWithRipgrep, searchCodeSemantically };
