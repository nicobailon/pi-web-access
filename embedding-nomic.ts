/**
 * Nomic Embed v1.5 - Matryoshka-trained embeddings (256-dim)
 * ONNX runtime with @xenova/transformers tokenizer
 * 
 * Natively trained with Matryoshka Representation Learning:
 * - 768-dim → 256-dim truncation with only 1.8% accuracy loss
 * - 1KB per embedding (vs 4KB for BGE-M3 float32)
 * - 1M docs = 1GB RAM (vs 4GB for BGE-M3)
 * - MTEB score: 62.28 (768) → 61.04 (256) = 98% accuracy preserved
 */

import { pipeline, env } from '@xenova/transformers';

// Disable downloading models from hub since we have local models
env.allowLocalModels = true;
env.useCache = true;

const NOMIC_MODEL_PATH = '/home/john/.local/llm/models/nomic-embed-v1.5';
const EMBEDDING_DIM = 256; // Matryoshka truncation to 256-dim

let featureExtractorPromise: Promise<any> | null = null;

/**
 * Get or create the feature extractor pipeline (loads once, cached)
 */
async function getFeatureExtractor(): Promise<any> {
	if (!featureExtractorPromise) {
		featureExtractorPromise = pipeline(
			'feature-extraction',
			NOMIC_MODEL_PATH,
			{ quantized: false },
		);
	}
	return featureExtractorPromise;
}

/**
 * Generate a single embedding using Nomic Embed v1.5
 * Returns 256-dim normalized embedding (Matryoshka truncated)
 */
export async function generateNomicEmbedding(text: string): Promise<number[]> {
	const extractor = await getFeatureExtractor();

	const output = await extractor(text, { pooling: 'mean', normalize: true });

	// output is a TypedArray (Float32Array or similar)
	const fullEmbedding = Array.from(output.data || output);

	// Truncate to 256-dim (Matryoshka)
	const truncated = fullEmbedding.slice(0, EMBEDDING_DIM);

	// L2 normalize (should already be normalized, but ensure it)
	const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0));
	if (norm > 0 && norm !== 1) {
		for (let i = 0; i < truncated.length; i++) {
			truncated[i] /= norm;
		}
	}

	return truncated;
}

/**
 * Generate batched embeddings using Nomic Embed v1.5
 * Processes multiple texts in a single inference call for maximum throughput
 */
export async function generateNomicBatchedEmbeddings(
	texts: string[],
	batchSize: number = 32,
): Promise<number[][]> {
	const extractor = await getFeatureExtractor();

	const allResults: number[][] = [];

	// Process in batches
	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);

		const output = await extractor(batch, { pooling: 'mean', normalize: true });

		// output is a 2D tensor: [batch_size, hidden_dim]
		const data = output.data || output;
		const shape = output.dims || output.shape;
		const hiddenDim = shape ? shape[shape.length - 1] : data.length / batch.length;

		for (let b = 0; b < batch.length; b++) {
			const start = b * hiddenDim;
			const embedding: number[] = [];
			for (let d = 0; d < hiddenDim; d++) {
				embedding.push(data[start + d]);
			}

			// Truncate to 256-dim (Matryoshka)
			const truncated = embedding.slice(0, EMBEDDING_DIM);

			// L2 normalize
			const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0));
			if (norm > 0 && norm !== 1) {
				for (let j = 0; j < truncated.length; j++) {
					truncated[j] /= norm;
				}
			}

			allResults.push(truncated);
		}
	}

	return allResults;
}

/**
 * Compute cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	normA = Math.sqrt(normA);
	normB = Math.sqrt(normB);

	if (normA === 0 || normB === 0) return 0;
	return dotProduct / (normA * normB);
}

/**
 * Get the embedding dimensions
 */
export function getEmbeddingDim(): number {
	return EMBEDDING_DIM;
}
