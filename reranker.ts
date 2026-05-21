/**
 * Gemma-4-E2B Reranker
 * Uses local LLM for semantic relevance scoring of search results
 * Implements Exa.ai-style reranking with prompt-based relevance scoring
 */

import { queryLocalLlm } from "./local-llm-api.js";

export interface RerankResult {
	url: string;
	title: string;
	snippet: string;
	score: number; // 1-10 relevance score
	reason: string;
}

export interface RerankOptions {
	/** Maximum number of results to rerank (default: 50) */
	maxResults?: number;
	/** Batch size for LLM calls (default: 10) */
	batchSize?: number;
	/** Temperature for LLM (default: 0.3 for consistency) */
	temperature?: number;
	/** Max tokens for LLM response (default: 256) */
	maxTokens?: number;
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 256;

/**
 * Rerank search results using Gemma-4-E2B
 * 
 * Sends batches of results to the LLM for relevance scoring.
 * Each result is scored on a scale of 1-10 based on relevance to the query.
 * 
 * @param query - The search query
 * @param results - Array of search results to rerank
 * @param options - Reranking options
 * @returns Array of reranked results with relevance scores
 */
export async function rerankWithGemma4(
	query: string,
	results: Array<{ url: string; title: string; snippet: string }>,
	options: RerankOptions = {},
): Promise<RerankResult[]> {
	const {
		maxResults = 50,
		batchSize = DEFAULT_BATCH_SIZE,
		temperature = DEFAULT_TEMPERATURE,
		maxTokens = DEFAULT_MAX_TOKENS,
	} = options;

	// Limit results to rerank
	const limitedResults = results.slice(0, maxResults);

	if (limitedResults.length === 0) {
		return [];
	}

	// Split into batches
	const batches: typeof limitedResults[] = [];
	for (let i = 0; i < limitedResults.length; i += batchSize) {
		batches.push(limitedResults.slice(i, i + batchSize));
	}

	// Process each batch
	const allResults: RerankResult[] = [];
	for (const batch of batches) {
		const batchResults = await rerankBatch(query, batch, {
			temperature,
			maxTokens,
		});
		allResults.push(...batchResults);
	}

	// Sort by score (descending)
	allResults.sort((a, b) => b.score - a.score);

	return allResults;
}

/**
 * Rerank a single batch of results
 * 
 * @param query - The search query
 * @param batch - Array of results to rerank
 * @param options - Reranking options
 * @returns Array of reranked results with relevance scores
 */
async function rerankBatch(
	query: string,
	batch: Array<{ url: string; title: string; snippet: string }>,
	options: { temperature?: number; maxTokens?: number },
): Promise<RerankResult[]> {
	const { temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS } = options;

	// Build prompt for batch reranking
	const prompt = buildRerankPrompt(query, batch);

	try {
		const response = await queryLocalLlm(prompt, {
			temperature,
			maxTokens,
			timeoutMs: 30000, // 30 second timeout per batch
		});

		// Parse JSON response
		const parsed = parseRerankResponse(response);
		return parsed;
	} catch (error) {
		console.error(`Reranking failed for batch: ${error}`);
		// Return results with default scores if reranking fails
		return batch.map((r) => ({
			url: r.url,
			title: r.title,
			snippet: r.snippet,
			score: 5, // Default medium score
			reason: "Reranking failed, default score",
		}));
	}
}

/**
 * Build the reranking prompt for Gemma-4-E2B
 * 
 * @param query - The search query
 * @param results - Array of results to score
 * @returns Prompt string for the LLM
 */
function buildRerankPrompt(
	query: string,
	results: Array<{ url: string; title: string; snippet: string }>,
): string {
	const resultsText = results
		.map(
			(r, i) =>
				`${i + 1}. URL: ${r.url}\n   Title: ${r.title}\n   Snippet: ${r.snippet?.slice(0, 500) || "No snippet available"}`,
		)
		.join("\n\n");

	return `You are a relevance scorer for search results. Your job is to rate how relevant each result is to the query.

Query: ${query}

Results to score:
${resultsText}

For each result, provide a relevance score from 1-10 and a brief reason.
- 10: Perfect match, directly answers the query
- 8-9: Very relevant, closely matches the query intent
- 6-7: Somewhat relevant, partially addresses the query
- 4-5: Weakly relevant, tangentially related
- 1-3: Not relevant, does not address the query

Return ONLY a valid JSON array with this exact structure (no markdown, no extra text):
[
  {
    "url": "https://...",
    "score": <1-10>,
    "reason": "Brief explanation of why this score was given"
  },
  ...
]

IMPORTANT: Return ONLY the JSON array. Do not include any other text, markdown formatting, or explanations.`;
}

/**
 * Parse the reranking response from Gemma-4-E2B
 * 
 * @param response - Raw LLM response
 * @returns Array of reranked results
 */
function parseRerankResponse(response: string): RerankResult[] {
	// Try to extract JSON from the response
	let jsonStr = response.trim();

	// Remove markdown code blocks if present
	if (jsonStr.startsWith("```")) {
		const lines = jsonStr.split("\n");
		jsonStr = lines
			.slice(1, -1)
			.join("\n")
			.trim();
	}

	// Try to find JSON array
	const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
	if (!jsonMatch) {
		throw new Error(`No JSON array found in response: ${response.slice(0, 200)}`);
	}

	const parsed = JSON.parse(jsonMatch[0]);

	// Validate and transform
	return parsed.map((item: any) => ({
		url: item.url || "",
		title: "", // Title will be filled in by caller
		snippet: "", // Snippet will be filled in by caller
		score: Math.max(1, Math.min(10, parseInt(item.score) || 5)),
		reason: item.reason || "No reason provided",
	}));
}

/**
 * Rerank with fallback to cosine similarity
 * 
 * If the LLM reranking fails, falls back to cosine similarity scoring.
 * 
 * @param query - The search query
 * @param results - Array of search results
 * @param embeddings - Array of embeddings for cosine similarity
 * @param queryEmbedding - Query embedding for cosine similarity
 * @param options - Reranking options
 * @returns Array of reranked results
 */
export async function rerankWithFallback(
	query: string,
	results: Array<{ url: string; title: string; snippet: string; embedding?: number[] }>,
	queryEmbedding: number[],
	options: RerankOptions = {},
): Promise<RerankResult[]> {
	// Try LLM reranking first
	try {
		const llmResults = await rerankWithGemma4(query, results, options);

		// If we got good results, use them
		if (llmResults.length > 0) {
			return llmResults;
		}
	} catch (error) {
		console.warn(`LLM reranking failed, falling back to cosine similarity: ${error}`);
	}

	// Fallback to cosine similarity
	return results
		.filter((r) => r.embedding)
		.map((r) => ({
			url: r.url,
			title: r.title,
			snippet: r.snippet,
			score: cosineSimilarity(r.embedding!, queryEmbedding),
			reason: "Cosine similarity fallback",
		}))
		.sort((a, b) => b.score - a.score);
}

/**
 * Compute cosine similarity between two embeddings
 * 
 * @param a - First embedding
 * @param b - Second embedding
 * @returns Cosine similarity score (-1 to 1)
 */
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const normProduct = Math.sqrt(normA) * Math.sqrt(normB);
	if (normProduct === 0) return 0;

	return dotProduct / normProduct;
}

/**
 * Benchmark reranking performance
 * 
 * @param iterations - Number of iterations to benchmark
 * @param batchSize - Batch size for reranking
 * @returns Benchmark results
 */
export async function benchmarkReranking(
	iterations: number = 10,
	batchSize: number = 10,
): Promise<{
	avgLatencyMs: number;
	totalLatencyMs: number;
}> {
	const query = "What are the latest advances in artificial intelligence?";
	const results = Array.from({ length: batchSize }, (_, i) => ({
		url: `https://example.com/result-${i}`,
		title: `Example Result ${i + 1}`,
		snippet: `This is a sample snippet for result ${i + 1}. It contains some relevant information about the topic.`,
	}));

	const latencies: number[] = [];

	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		await rerankWithGemma4(query, results, { batchSize, maxResults: batchSize });
		const end = performance.now();
		latencies.push(end - start);
	}

	return {
		avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
		totalLatencyMs: latencies.reduce((a, b) => a + b, 0),
	};
}
