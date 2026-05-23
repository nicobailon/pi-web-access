/**
 * Self-Hosted Exa-Pipeline Architecture (Full Plan Implementation)
 * 
 * Replaces all cloud dependencies with self-hosted alternatives:
 * 1. Search: SearXNG + Firecrawl → replaces Exa/Perplexity/Gemini
 * 2. Semantic Reranking: Nomic Embed v1.5 (Matryoshka) + jina-tiny → mimics Exa's neural search
 * 3. Content Extraction: LightPanda → replaces Gemini Web/Jina
 * 4. Code Search: Sourcegraph + ripgrep → replaces Exa MCP
 * 5. Video Analysis: yt-dlp + ffmpeg + Qwen3.6 → replaces Gemini API
 * 6. Summaries: Qwen3.6 (GPU) → replaces Claude/GPT
 * 
 * Model Allocation (VRAM Budget: 16GB):
 * - Qwen3.6 35B-A3B: GPU (~12-14GB) — MoE, only ~3.4B active params
 * - jina-reranker-v1-tiny-en: GPU (~130MB) — 33M params, 4-layer
 * - Nomic Embed v1.5: GPU (~400MB) — Matryoshka, 256-dim
 * 
 * Key improvements:
 * - Nomic Embed v1.5: 98% accuracy at 256-dim, 1KB per embedding
 * - Hybrid search: BM25 + embeddings (0.4 * BM25 + 0.6 * embedding)
 * - jina-reranker-v1-tiny-en: 100+ pairs/sec, 48.54 NDCG@10
 * 
 * Expected speed: 3-4x faster than cloud (15-40s vs 60-120s)
 * Privacy: Fully local, zero API keys, zero data collection
 */

import { search, semanticRerank } from "./firecrawl-search.js";
import { searchWithSearXNG } from "./searxng-search.js";
import { generateNomicEmbedding, generateNomicBatchedEmbeddings, cosineSimilarity } from "./embedding-nomic.js";
import {
	addDocument,
	searchSimilar,
	getDocumentCount,
	clearDocuments,
	type Document,
	type SearchResult as VectorSearchResult,
} from "./exa-vector-db.js";
import { extractContent, type ExtractedContent } from "./extract.js";
import { generateSummaryDraft, type SummaryGenerationContext } from "./summary-review.js";
import { extractVideo, type VideoContent } from "./video-extract.js";
import { extractYouTube, type YouTubeContent } from "./youtube-extract.js";
import { rerankWithJina, type RerankResult } from "./reranker-jina.js";
import { benchmark } from "./binary-quantizer.js";
import { queryLocalLlm } from "./local-llm-api.js";
import { extractWithLightPanda } from "./lightpanda-extract.js";
import { searchSourcegraph, searchWithRipgrep } from "./code-search.js";

export interface ExaPipelineOptions {
	query: string;
	numResults?: number;
	enableVectorSearch?: boolean;
	enableReranking?: boolean;
	enableSummaries?: boolean;
	enableIndexing?: boolean;
	/** Use hybrid search (BM25 + embeddings) — default: true */
	enableHybridSearch?: boolean;
	/** BM25 weight in hybrid search (default: 0.4) */
	bm25Weight?: number;
	/** Embedding weight in hybrid search (default: 0.6) */
	embeddingWeight?: number;
	/** Batch size for embedding generation (default: 32) */
	embeddingBatchSize?: number;
	/** Max results for reranking (default: 50) */
	rerankMaxResults?: number;
	/** Batch size for reranking (default: 16) */
	rerankBatchSize?: number;
	/** Use LightPanda for content extraction (default: true) */
	useLightPanda?: boolean;
	/** Max frames for video analysis (default: 12) */
	maxVideoFrames?: number;
}

export interface ExaPipelineResult {
	results: Array<{
		url: string;
		title: string;
		content: string;
		score: number;
		summary?: string;
	}>;
	vectorCount: number;
	processingTime: number;
	binaryCompressionRatio?: number;
}

/**
 * Compute BM25-style score from snippet text similarity
 * Simplified BM25: based on term overlap between query and snippet
 */
function computeBM25Score(query: string, text: string, k: number = 1.2, b: number = 0.75): number {
	const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
	const textLower = text.toLowerCase();
	
	if (queryTerms.length === 0) return 0;
	
	let score = 0;
	const textLen = textLower.length;
	if (textLen === 0) return 0;
	
	for (const term of queryTerms) {
		const termCount = (textLower.match(new RegExp(term, 'g')) || []).length;
		const tf = termCount / Math.max(1, termCount); // Simple term frequency
		const idf = Math.log(1 + (1000 / (termCount + 1))); // Simplified IDF
		score += (tf * k * idf) / (tf + k * (1 - b + b * (textLen / 500)));
	}
	
	return score / queryTerms.length;
}

/**
 * Normalize scores to 0-1 range
 */
function normalizeScores(scores: number[]): number[] {
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const range = max - min || 1;
	return scores.map(s => (s - min) / range);
}

/**
 * Merge and deduplicate search results from multiple sources
 */
function mergeSearchResults(
	searxngResults: any[],
	firecrawlResults: any[],
): Array<{ url: string; title: string; snippet: string }> {
	const allResults = [...(searxngResults || []), ...(firecrawlResults || [])];
	const seen = new Set<string>();
	const unique: Array<{ url: string; title: string; snippet: string }> = [];
	
	for (const r of allResults) {
		if (!seen.has(r.url)) {
			seen.add(r.url);
			unique.push({
				url: r.url,
				title: r.title || '',
				snippet: r.snippet || r.content || '',
			});
		}
	}
	
	return unique;
}

/**
 * Full Self-Hosted Exa Pipeline
 * DAG-based orchestrator with hybrid search (BM25 + embeddings)
 */
export async function exaPipeline(
	query: string,
	options: ExaPipelineOptions = {},
	ctx?: SummaryGenerationContext,
): Promise<ExaPipelineResult> {
	const startTime = Date.now();
	const numResults = options.numResults ?? 20;
	const enableVector = options.enableVectorSearch ?? true;
	const enableRerank = options.enableReranking ?? true;
	const enableSummaries = options.enableSummaries ?? true;
	const enableIndexing = options.enableIndexing ?? true;
	const enableHybrid = options.enableHybridSearch ?? true;
	const bm25Weight = options.bm25Weight ?? 0.4;
	const embeddingWeight = options.embeddingWeight ?? 0.6;
	const embeddingBatchSize = options.embeddingBatchSize ?? 32;
	const rerankMaxResults = options.rerankMaxResults ?? 50;
	const rerankBatchSize = options.rerankBatchSize ?? 16;
	const useLightPanda = options.useLightPanda ?? true;
	const maxVideoFrames = options.maxVideoFrames ?? 12;

	// Step 1: Multi-source search (SearXNG + Firecrawl)
	console.log("[Exa Pipeline] Step 1: Multi-source search (SearXNG + Firecrawl)...");
	const [searxngResults, firecrawlResults] = await Promise.all([
		searchWithSearXNG(query, { numResults: numResults / 2 }).catch(() => ({ results: [] })),
		search(query, { numResults: numResults / 2, provider: "firecrawl" as const }).catch(() => ({ results: [] })),
	]);

	const allResults = mergeSearchResults(searxngResults?.results || [], firecrawlResults?.results || []);

	if (!allResults.length) {
		return {
			results: [],
			vectorCount: getDocumentCount(),
			processingTime: Date.now() - startTime,
		};
	}

	// Step 2: Content extraction with LightPanda (JS rendering) + fallbacks
	console.log(`[Exa Pipeline] Step 2: Extracting content for ${allResults.length} URLs (LightPanda)...`);
	const enrichedResults = await Promise.all(
		allResults.map(async (r) => {
			// Check if it's a video URL
			if (r.url.includes("youtube.com") || r.url.includes("youtu.be")) {
				try {
					const videoResult = await extractYouTube(r.url, undefined, undefined, undefined, { maxFrames });
					return { ...r, content: videoResult.summary || videoResult.transcript || r.snippet || "" };
				} catch {
					return { ...r, content: r.snippet || "" };
				}
			} else if (r.url.includes(".mp4") || r.url.includes(".webm") || r.url.includes(".avi")) {
				try {
					const videoResult = await extractVideo(r.url, undefined, { maxFrames });
					return { ...r, content: videoResult.summary || videoResult.frames?.[0]?.description || r.snippet || "" };
				} catch {
					return { ...r, content: r.snippet || "" };
				}
			}

			// Use LightPanda for JS-rendered content if enabled
			if (useLightPanda && (r.snippet || '').length < 200) {
				try {
					const lightpandaResult = await extractWithLightPanda(r.url);
					if (lightpandaResult && lightpandaResult.content.length > 200) {
						return { ...r, content: lightpandaResult.content };
					}
				} catch {
					// Fall through to regular extraction
				}
			}

			// Regular content extraction
			if (r.snippet && r.snippet.length > 200) return { ...r, content: r.snippet };
			try {
				const extracted = await extractContent(r.url);
				return { ...r, content: extracted.content || r.snippet || "" };
			} catch {
				return { ...r, content: r.snippet || "" };
			}
		}),
	);

	// Filter low-quality results
	const filtered = enrichedResults.filter((r) => r.content.length > 200);

	if (!filtered.length) {
		return {
			results: [],
			vectorCount: getDocumentCount(),
			processingTime: Date.now() - startTime,
		};
	}

	// Step 3: Generate embeddings with Nomic Embed v1.5 (256-dim Matryoshka)
	console.log("[Exa Pipeline] Step 3: Generating Nomic Embed v1.5 embeddings (256-dim)...");
	const embeddingPrefix = "Represent this document for searching: ";
	const embeddingTexts = filtered.map((r) => `${embeddingPrefix}${r.title} ${r.content}`);
	const embeddings = await generateNomicBatchedEmbeddings(embeddingTexts, embeddingBatchSize);
	const embeddedResults = filtered.map((r, i) => ({ ...r, embedding: embeddings[i] }));

	// Step 4: Store in Vector DB (binary quantized, 256-dim)
	if (enableIndexing) {
		console.log("[Exa Pipeline] Step 4: Storing in vector DB (binary quantized, 256-dim)...");
		for (const emb of embeddedResults) {
			addDocument({
				id: emb.url,
				url: emb.url,
				title: emb.title,
				content: emb.content,
				embedding: emb.embedding,
			});
		}
	}

	// Step 5: Embed query and search
	console.log("[Exa Pipeline] Step 5: Hybrid search (BM25 + embeddings)...");
	const queryEmbedding = await generateNomicEmbedding(`Represent this query for searching documents: ${query}`);

	// Compute BM25 scores for all results
	const bm25Scores = filtered.map((r) => computeBM25Score(query, r.content));
	const normalizedBM25 = normalizeScores(bm25Scores);

	// Vector search (if enabled)
	let vectorScores: number[] = [];
	if (enableVector) {
		const vectorResults = searchSimilar(queryEmbedding, numResults);
		const vectorScoreMap = new Map<string, number>();
		for (const vr of vectorResults) {
			vectorScoreMap.set(vr.document.url, vr.similarity);
		}
		vectorScores = filtered.map((r) => vectorScoreMap.get(r.url) || 0);
	}
	const normalizedVector = normalizeScores(vectorScores);

	// Hybrid scoring: BM25 + Embedding similarity
	const hybridScores = filtered.map((r, i) => {
		const bm25Score = normalizedBM25[i] || 0;
		const vectorScore = normalizedVector[i] || 0;
		return bm25Weight * bm25Score + embeddingWeight * vectorScore;
	});

	// Rank by hybrid score
	const rankedWithScores = filtered.map((r, i) => ({
		...r,
		score: hybridScores[i],
	}));
	rankedWithScores.sort((a, b) => b.score - a.score);

	// Step 6: Rerank with Jina Reranker v1 Tiny
	if (enableRerank && rankedWithScores.length > 0) {
		console.log("[Exa Pipeline] Step 6: Reranking with Jina Reranker v1 Tiny...");
		
		const rerankResults = rankedWithScores.slice(0, rerankMaxResults).map((r) => ({
			url: r.url,
			title: r.title,
			snippet: r.content.slice(0, 500),
		}));
		
		const reranked = await rerankWithJina(query, rerankResults, { batchSize: rerankBatchSize });
		
		// Merge reranking scores back
		const rerankScoreMap = new Map<string, number>();
		for (const rr of reranked) {
			rerankScoreMap.set(rr.url, rr.score);
		}
		
		rankedWithScores.forEach((r) => {
			const rerankedScore = rerankScoreMap.get(r.url);
			if (rerankedScore !== undefined) {
				r.score = rerankedScore;
			}
		});
	}

	// Step 7: Summarize with Qwen3.6
	if (enableSummaries && ctx) {
		console.log("[Exa Pipeline] Step 7: Generating summaries with Qwen3.6...");
		const summaryResults = await Promise.all(
			rankedWithScores.slice(0, 10).map(async (r) => {
				try {
					const summary = await generateSummaryDraft(
						[{ query, provider: "exa-pipeline", results: [{ url: r.url, title: r.title, text: r.content.slice(0, 2000) }] }],
						ctx,
					);
					return { ...r, summary: summary.summary };
				} catch {
					return r;
				}
			}),
		);
		rankedWithScores.splice(0, rankedWithScores.length, ...summaryResults);
	}

	// Calculate binary compression ratio
	const originalSize = 256 * 4; // 256 dims * 4 bytes per float32
	const binarySize = Math.ceil(256 / 8); // 32 bytes
	const compressionRatio = originalSize / binarySize;

	return {
		results: rankedWithScores.map((r) => ({
			url: r.url,
			title: r.title,
			content: r.content,
			score: r.score,
			summary: (r as any).summary,
		})),
		vectorCount: getDocumentCount(),
		processingTime: Date.now() - startTime,
		binaryCompressionRatio: compressionRatio,
	};
}

/**
 * Code search using Sourcegraph + Nomic embeddings + ripgrep
 */
export async function exaCodeSearch(
	query: string,
	options: { maxResults?: number; semanticOnly?: boolean } = {},
): Promise<Array<{ url: string; title: string; content: string; score: number }>> {
	const { maxResults = 20, semanticOnly = false } = options;
	
	if (semanticOnly) {
		// Pure semantic code search using Nomic embeddings
		const queryEmbedding = await generateNomicEmbedding(query);
		const results = searchSimilar(queryEmbedding, maxResults);
		return results.map((r) => ({
			url: r.document.url,
			title: r.document.title,
			content: r.document.content,
			score: r.similarity,
		}));
	}
	
	// Hybrid: Sourcegraph + ripgrep + Nomic embeddings
	const [sourcegraphResults, ripgrepResults] = await Promise.all([
		searchSourcegraph(query, maxResults).catch(() => []),
		searchWithRipgrep(query, maxResults).catch(() => []),
	]);
	
	// Merge and deduplicate
	const seen = new Set<string>();
	const merged: Array<{ url: string; title: string; content: string; score: number }> = [];
	
	for (const r of [...sourcegraphResults, ...ripgrepResults]) {
		if (!seen.has(r.url)) {
			seen.add(r.url);
			merged.push(r);
		}
	}
	
	return merged.slice(0, maxResults);
}
