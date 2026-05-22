/**
 * Exa.ai-style Semantic Search Pipeline (v3)
 * Full pipeline: Crawl → Embed → Binary Quantize → Store → Search → Rerank → Summarize
 * Uses: LightPanda + SearXNG + Firecrawl for fetching, BGE-M3 for embeddings,
 *       BGE-large for reranking, Qwen3.6 for summarization
 */

import { search, semanticRerank } from "./firecrawl-search.js";
import { searchWithSearXNG } from "./searxng-search.js";
import { searchWithLightPanda } from "./lightpanda-search.js";
import { generateEmbedding, generateBatchedEmbeddings } from "./local-llm-api.js";
import {
	addDocument,
	searchSimilar,
	getDocumentCount,
	clearDocuments,
	type Document,
	type SearchResult,
} from "./exa-vector-db.js";
import { extractContent, type ExtractedContent } from "./extract.js";
import { generateSummaryDraft, type SummaryGenerationContext } from "./summary-review.js";
import { extractVideo, type VideoContent } from "./video-extract.js";
import { extractYouTube, type YouTubeContent } from "./youtube-extract.js";
import { rerankWithBge, type RerankResult } from "./reranker-bge.js";
import { benchmark, benchmarkReranking } from "./binary-quantizer.js";

export interface ExaPipelineOptions {
	query: string;
	numResults?: number;
	enableVectorSearch?: boolean;
	enableReranking?: boolean;
	enableSummaries?: boolean;
	enableIndexing?: boolean;
	/** Use BGE reranking instead of cosine similarity (default: true) */
	enableLLMReranking?: boolean;
	/** Batch size for BGE reranking (default: 50) */
	rerankBatchSize?: number;
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
 * Full Exa.ai-style pipeline (v2)
 * Uses: LightPanda + SearXNG + Firecrawl for fetching, BGE-M3 for embeddings,
 *       binary quantization for memory efficiency, BGE-large for reranking
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
	const enableLLMRerank = options.enableLLMReranking ?? true;
	const rerankBatchSize = options.rerankBatchSize ?? 10;

	// Step 1: Multi-source search (SearXNG + Firecrawl + LightPanda)
	console.log("[Exa Pipeline] Step 1: Multi-source search...");
	const [searxngResults, firecrawlResults] = await Promise.all([
		searchWithSearXNG(query, { numResults: numResults / 2 }).catch(() => ({ results: [] })),
		search(query, { numResults: numResults / 2, provider: "firecrawl" as const }).catch(() => ({ results: [] })),
	]);

	// Combine and deduplicate results
	const allResults = [...(searxngResults?.results || []), ...(firecrawlResults?.results || [])];
	const uniqueResults = Array.from(new Map(allResults.map(r => [r.url, r])).values());

	if (!uniqueResults.length) {
		return {
			results: [],
			vectorCount: getDocumentCount(),
			processingTime: Date.now() - startTime,
		};
	}

	// Step 2: Extract content with multimodal support (Qwen3.6)
	console.log("[Exa Pipeline] Step 2: Extracting content with multimodal...");
	const enrichedResults = await Promise.all(
		uniqueResults.map(async (r) => {
			// Check if it's a video URL
			if (r.url.includes("youtube.com") || r.url.includes("youtu.be")) {
				try {
					const videoResult = await extractYouTube(r.url);
					return { ...r, content: videoResult.summary || videoResult.transcript || r.snippet || "" };
				} catch {
					return { ...r, content: r.snippet || "" };
				}
			} else if (r.url.includes(".mp4") || r.url.includes(".webm") || r.url.includes(".avi")) {
				try {
					const videoResult = await extractVideo(r.url);
					return { ...r, content: videoResult.summary || videoResult.frames?.[0]?.description || r.snippet || "" };
				} catch {
					return { ...r, content: r.snippet || "" };
				}
			}

			// Regular content extraction
			if (r.snippet?.length > 200) return { ...r, content: r.snippet };
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

	// Step 3: Embed with BGE-M3 (1024-dim) -> Binary Quantize
	console.log("[Exa Pipeline] Step 3: Generating BGE-M3 embeddings...");
	const embeddedResults = await Promise.all(
		filtered.map(async (r) => {
			const embedding = await generateEmbedding(`Represent this document for searching: ${r.title} ${r.content}`);
			return { ...r, embedding };
		}),
	);

	// Step 4: Store in Vector DB (binary quantized)
	if (enableIndexing) {
		console.log("[Exa Pipeline] Step 4: Storing in vector DB (binary quantized)...");
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

	// Step 5: Embed query and search (binary cosine similarity)
	console.log("[Exa Pipeline] Step 5: Semantic search (binary quantized)...");
	const queryEmbedding = await generateEmbedding(`Represent this query for searching documents: ${query}`);

	let ranked = filtered;
	if (enableVector) {
		const vectorResults = searchSimilar(queryEmbedding, numResults);
		ranked = vectorResults.map((vr) => ({
			url: vr.document.url,
			title: vr.document.title,
			content: vr.document.content,
			score: vr.similarity,
		}));
	}

	// Step 6: Rerank (BGE-large reranker)
	if (enableRerank && ranked.length > 0) {
		console.log("[Exa Pipeline] Step 6: Reranking with BGE-large...");
		
		// Convert to reranker format
		const rerankResults = ranked.map((r) => ({
			url: r.url,
			title: r.title,
			snippet: r.content.slice(0, 500),
		}));
		
		// Use BGE reranking if enabled, otherwise fallback to cosine similarity
		let reranked: RerankResult[];
		if (enableLLMRerank) {
			reranked = await rerankWithBge(query, rerankResults, { batchSize: rerankBatchSize });
		} else {
			reranked = await rerankWithFallback(query, ranked as any, queryEmbedding, { batchSize: rerankBatchSize });
		}
		
		// Merge reranking scores back
		ranked = ranked.map((r) => {
			const rerankedResult = reranked.find((rr) => rr.url === r.url);
			return {
				...r,
				score: rerankedResult ? rerankedResult.score : r.score,
			};
		});
	}

	// Step 7: Summarize with Qwen3.6
	if (enableSummaries && ctx) {
		console.log("[Exa Pipeline] Step 7: Generating summaries with Qwen3.6...");
		const summaryResults = await Promise.all(
			ranked.slice(0, 10).map(async (r) => {
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
		ranked = summaryResults;
	}

	// Calculate binary compression ratio
	const originalSize = 1024 * 4; // 1024 dims * 4 bytes per float32
	const binarySize = Math.ceil(1024 / 8); // 128 bytes
	const compressionRatio = originalSize / binarySize;

	return {
		results: ranked.map((r) => ({
			url: r.url,
			title: r.title,
			content: r.content,
			score: "score" in r ? (r as any).score : 0,
			summary: "summary" in r ? (r as any).summary : undefined,
		})),
		vectorCount: getDocumentCount(),
		processingTime: Date.now() - startTime,
		binaryCompressionRatio: compressionRatio,
	};
}
