/**
 * Binary Quantizer for Embeddings
 * Numpy-like binary quantization operations for memory-efficient vector storage
 * 
 * Compression: 256 float32 (1024 bytes) → 256 bits (32 bytes) = 32x savings
 * Method: Sign-based binary quantization (embedding > 0 ? 1 : 0)
 * For Nomic Embed v1.5 (256-dim Matryoshka)
 */

export interface BinaryQuantizerOptions {
	/** Number of dimensions in the embedding (default: 256) */
	dimensions?: number;
}

export interface QuantizationResult {
	/** Binary embedding as Uint8Array (32 bytes for 256-dim) */
	binary: Uint8Array;
	/** Original float32 embedding */
	original: Float32Array;
	/** Compression ratio (original size / binary size) */
	compressionRatio: number;
}

export interface SimilarityResult {
	/** Cosine similarity score (0-1) */
	similarity: number;
	/** Hamming distance between binary embeddings */
	hammingDistance: number;
	/** Total bits compared */
	totalBits: number;
}

const DEFAULT_DIMENSIONS = 256;
const BYTES_PER_EMBEDDING = Math.ceil(DEFAULT_DIMENSIONS / 8); // 32 bytes for 256 dims

/**
 * Quantize a float32 embedding to binary (sign-based)
 * 
 * Algorithm:
 * 1. For each dimension: if value > 0, set bit to 1, else 0
 * 2. Pack bits into bytes (8 bits per byte)
 * 
 * @param embedding - Float32 array of embedding values
 * @param options - Quantization options
 * @returns QuantizationResult with binary representation
 */
export function quantize(
	embedding: Float32Array | number[],
	options: BinaryQuantizerOptions = {},
): QuantizationResult {
	const dimensions = options.dimensions || DEFAULT_DIMENSIONS;
	const BYTES_PER_VEC = Math.ceil(dimensions / 8);

	// Convert to Float32Array if needed
	const floatArr = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);

	// Create binary representation
	const binary = new Uint8Array(BYTES_PER_VEC);

	// Pack bits into bytes
	for (let i = 0; i < dimensions; i++) {
		const byteIndex = Math.floor(i / 8);
		const bitIndex = i % 8;
		if (floatArr[i] > 0) {
			binary[byteIndex] |= (1 << bitIndex);
		}
	}

	return {
		binary,
		original: floatArr,
		compressionRatio: (floatArr.byteLength / binary.byteLength),
	};
}

/**
 * Dequantize a binary embedding back to float32
 * 
 * Algorithm:
 * 1. Unpack bits from bytes
 * 2. Convert: bit 1 → 1.0, bit 0 → -1.0
 * 
 * @param binary - Binary embedding as Uint8Array
 * @param options - Dequantization options
 * @returns Float32Array of dequantized values
 */
export function dequantize(
	binary: Uint8Array,
	options: BinaryQuantizerOptions = {},
): Float32Array {
	const dimensions = options.dimensions || DEFAULT_DIMENSIONS;
	const BYTES_PER_VEC = Math.ceil(dimensions / 8);

	// Validate input size
	if (binary.length < BYTES_PER_VEC) {
		throw new Error(
			`Binary embedding too small: expected ${BYTES_PER_VEC} bytes, got ${binary.length}`,
		);
	}

	// Create dequantized embedding
	const embedding = new Float32Array(dimensions);

	// Unpack bits from bytes
	for (let i = 0; i < dimensions; i++) {
		const byteIndex = Math.floor(i / 8);
		const bitIndex = i % 8;
		const isPositive = (binary[byteIndex] >> bitIndex) & 1;
		embedding[i] = isPositive ? 1.0 : -1.0;
	}

	return embedding;
}

/**
 * Compute cosine similarity between two float32 embeddings
 * 
 * @param a - First embedding
 * @param b - Second embedding
 * @returns Cosine similarity score (-1 to 1)
 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
	const arrA = a instanceof Float32Array ? a : new Float32Array(a);
	const arrB = b instanceof Float32Array ? b : new Float32Array(b);

	if (arrA.length !== arrB.length) {
		throw new Error(`Dimension mismatch: ${arrA.length} vs ${arrB.length}`);
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < arrA.length; i++) {
		dotProduct += arrA[i] * arrB[i];
		normA += arrA[i] * arrA[i];
		normB += arrB[i] * arrB[i];
	}

	const normProduct = Math.sqrt(normA) * Math.sqrt(normB);
	if (normProduct === 0) return 0;

	return dotProduct / normProduct;
}

/**
 * Compute binary cosine similarity using Hamming distance
 * 
 * For binary embeddings (±1), cosine similarity = 1 - (2 * hamming_distance / dimensions)
 * This is equivalent to: (dimensions - 2 * hamming_distance) / dimensions
 * 
 * @param a - First binary embedding (Uint8Array)
 * @param b - Second binary embedding (Uint8Array)
 * @param options - Similarity options
 * @returns SimilarityResult with cosine similarity and hamming distance
 */
export function binaryCosineSimilarity(
	a: Uint8Array,
	b: Uint8Array,
	options: BinaryQuantizerOptions = {},
): SimilarityResult {
	const dimensions = options.dimensions || DEFAULT_DIMENSIONS;
	const BYTES_PER_VEC = Math.ceil(dimensions / 8);

	// Validate input sizes
	if (a.length < BYTES_PER_VEC || b.length < BYTES_PER_VEC) {
		throw new Error(
			`Binary embedding too small: expected ${BYTES_PER_VEC} bytes, got ${a.length} and ${b.length}`,
		);
	}

	// Count differing bits (Hamming distance)
	let hammingDistance = 0;
	for (let i = 0; i < BYTES_PER_VEC; i++) {
		hammingDistance += popcount(a[i] ^ b[i]);
	}

	// Adjust for dimensions that aren't multiples of 8
	const actualBits = dimensions;

	// Compute cosine similarity from Hamming distance
	// For binary embeddings: cosine_sim = 1 - (2 * hamming_distance / total_bits)
	const similarity = 1.0 - (2.0 * hammingDistance / actualBits);

	return {
		similarity: Math.max(-1.0, Math.min(1.0, similarity)),
		hammingDistance,
		totalBits: actualBits,
	};
}

/**
 * Count set bits in a byte (population count)
 * 
 * @param byte - Input byte
 * @returns Number of set bits (0-8)
 */
function popcount(byte: number): number {
	let count = 0;
	while (byte) {
		count += byte & 1;
		byte >>= 1;
	}
	return count;
}

/**
 * Batch quantize multiple embeddings
 * 
 * @param embeddings - Array of float32 embeddings
 * @param options - Quantization options
 * @returns Array of QuantizationResult
 */
export function batchQuantize(
	embeddings: (Float32Array | number[])[],
	options: BinaryQuantizerOptions = {},
): QuantizationResult[] {
	return embeddings.map((emb) => quantize(emb, options));
}

/**
 * Batch dequantize multiple binary embeddings
 * 
 * @param binaries - Array of binary embeddings (Uint8Array)
 * @param options - Dequantization options
 * @returns Array of Float32Array
 */
export function batchDequantize(
	binaries: Uint8Array[],
	options: BinaryQuantizerOptions = {},
): Float32Array[] {
	return binaries.map((bin) => dequantize(bin, options));
}

/**
 * Compute pairwise similarities between two sets of binary embeddings
 * 
 * @param binariesA - First set of binary embeddings
 * @param binariesB - Second set of binary embeddings
 * @param options - Similarity options
 * @returns Matrix of similarity scores (binariesA.length x binariesB.length)
 */
export function pairwiseSimilarity(
	binariesA: Uint8Array[],
	binariesB: Uint8Array[],
	options: BinaryQuantizerOptions = {},
): number[][] {
	const results: number[][] = [];

	for (const a of binariesA) {
		const row: number[] = [];
		for (const b of binariesB) {
			const result = binaryCosineSimilarity(a, b, options);
			row.push(result.similarity);
		}
		results.push(row);
	}

	return results;
}

/**
 * Benchmark binary quantization performance
 * 
 * @param iterations - Number of iterations to benchmark
 * @param dimensions - Embedding dimensions
 * @returns Benchmark results
 */
export function benchmark(iterations: number = 1000, dimensions: number = 256): {
	quantizeMs: number;
	dequantizeMs: number;
	similarityMs: number;
	compressionRatio: number;
} {
	// Generate random embeddings
	const embeddings: Float32Array[] = [];
	for (let i = 0; i < iterations; i++) {
		const arr = new Float32Array(dimensions);
		for (let j = 0; j < dimensions; j++) {
			arr[j] = (Math.random() - 0.5) * 2; // -1 to 1
		}
		embeddings.push(arr);
	}

	// Benchmark quantization
	const quantizeStart = performance.now();
	for (const emb of embeddings) {
		quantize(emb, { dimensions });
	}
	const quantizeMs = quantizeStart - performance.now();

	// Benchmark dequantization
	const binaries = embeddings.map((emb) => quantize(emb, { dimensions }).binary);
	const dequantizeStart = performance.now();
	for (const bin of binaries) {
		dequantize(bin, { dimensions });
	}
	const dequantizeMs = dequantizeStart - performance.now();

	// Benchmark similarity
	const similarityStart = performance.now();
	for (let i = 0; i < binaries.length - 1; i++) {
		binaryCosineSimilarity(binaries[i], binaries[i + 1], { dimensions });
	}
	const similarityMs = similarityStart - performance.now();

	const originalSize = embeddings[0].byteLength;
	const binarySize = Math.ceil(dimensions / 8);

	return {
		quantizeMs: quantizeMs / iterations,
		dequantizeMs: dequantizeMs / iterations,
		similarityMs: similarityMs / (iterations - 1),
		compressionRatio: originalSize / binarySize,
	};
}
