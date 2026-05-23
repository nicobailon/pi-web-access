/**
 * Jina Reranker v1 Tiny - Fast ONNX-based reranking
 * Uses jinaai/jina-reranker-v1-tiny-en for semantic reranking
 * 
 * Model specs:
 * - 33M params, 4-layer, 8192 token context
 * - 48.54 NDCG@10
 * - 100+ pairs/sec
 * - Only 130MB VRAM
 * - Cross-encoder reranking on top-K results
 * 
 * Much faster than LLM-based reranking (100+ pairs/sec vs ~10/sec)
 */

import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = true;
env.useCache = true;

const JINA_RERANKER_MODEL_PATH = '/home/john/.local/llm/models/jina-reranker-tiny';

let rerankerPromise: Promise<any> | null = null;

/**
 * Get or create the reranker pipeline (loads once, cached)
 */
async function getReranker(): Promise<any> {
	if (!rerankerPromise) {
		rerankerPromise = pipeline(
			'text-classification',
			JINA_RERANKER_MODEL_PATH,
			{ quantized: false },
		);
	}
	return rerankerPromise;
}

export interface RerankResult {
	url: string;
	title: string;
	score: number; // 0-1 relevance score
	reason: string;
}

export interface RerankOptions {
	maxResults?: number;
	batchSize?: number;
}

/**
 * Rerank search results using Jina Reranker v1 Tiny
 * Much faster than LLM-based reranking (100+ pairs/sec vs ~10/sec)
 */
export async function rerankWithJina(
	query: string,
	results: Array<{ url: string; title: string; snippet: string }>,
	options: RerankOptions = {},
): Promise<RerankResult[]> {
	const { maxResults = 50, batchSize = 16 } = options;
	const limitedResults = results.slice(0, maxResults);

	if (limitedResults.length === 0) {
		return [];
	}

	const reranker = await getReranker();

	// Split into batches
	const batches: typeof limitedResults[] = [];
	for (let i = 0; i < limitedResults.length; i += batchSize) {
		batches.push(limitedResults.slice(i, i + batchSize));
	}

	// Process each batch
	const allResults: RerankResult[] = [];
	for (const batch of batches) {
		const batchResults = await rerankBatchJina(query, batch, reranker);
		allResults.push(...batchResults);
	}

	// Sort by score (descending)
	allResults.sort((a, b) => b.score - a.score);

	return allResults;
}

async function rerankBatchJina(
	query: string,
	batch: Array<{ url: string; title: string; snippet: string }>,
	reranker: any,
): Promise<RerankResult[]> {
	// Jina reranker expects pairs of [query, document]
	const pairs = batch.map((r) => [
		query,
		`${r.title}. ${r.snippet?.slice(0, 500) || ''}`,
	]);

	// Run inference
	const outputs = await reranker(pairs, {
		topk: batch.length,
		truncate: true,
	});

	// Extract scores
	const scores = outputs.map((out: any) => {
		// Output is [{label, score}, ...] or [{score}, ...]
		if (typeof out === 'object' && out.score !== undefined) {
			return out.score;
		}
		if (typeof out === 'object' && out.label !== undefined) {
			return out.score || 0;
		}
		return 0;
	});

	// Map back to results
	return batch.map((r, i) => ({
		url: r.url,
		title: r.title,
		score: Math.max(0, Math.min(1, scores[i] || 0)),
		reason: `Jina reranker score: ${(scores[i] || 0).toFixed(3)}`,
	}));
}
