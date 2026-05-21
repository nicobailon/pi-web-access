/**
 * Benchmark script for binary quantization
 * Tests float32 vs binary quantization performance and accuracy
 */

import { quantize, dequantize, cosineSimilarity, binaryCosineSimilarity, benchmark } from "./binary-quantizer.js";

async function main() {
	console.log("=== Binary Quantization Benchmark ===\n");

	// Test 1: Performance benchmark
	console.log("1. Performance Benchmark (1000 iterations)");
	const perfResults = benchmark(1000, 1024);
	console.log(`   Quantize: ${perfResults.quantizeMs.toFixed(3)}ms per embedding`);
	console.log(`   Dequantize: ${perfResults.dequantizeMs.toFixed(3)}ms per embedding`);
	console.log(`   Similarity: ${perfResults.similarityMs.toFixed(3)}ms per comparison`);
	console.log(`   Compression Ratio: ${perfResults.compressionRatio.toFixed(1)}x`);
	console.log();

	// Test 2: Accuracy test
	console.log("2. Accuracy Test (float32 vs binary quantization)");
	const dimensions = 1024;
	const numTests = 100;
	let totalError = 0;

	for (let i = 0; i < numTests; i++) {
		// Generate random embeddings
		const embA = new Float32Array(dimensions);
		const embB = new Float32Array(dimensions);
		for (let j = 0; j < dimensions; j++) {
			embA[j] = (Math.random() - 0.5) * 2; // -1 to 1
			embB[j] = (Math.random() - 0.5) * 2;
		}

		// Compute float32 similarity
		const floatSim = cosineSimilarity(embA, embB);

		// Quantize to binary
		const quantA = quantize(embA, { dimensions });
		const quantB = quantize(embB, { dimensions });

		// Compute binary similarity
		const binaryResult = binaryCosineSimilarity(quantA.binary, quantB.binary, { dimensions });

		// Compute error
		const error = Math.abs(floatSim - binaryResult.similarity);
		totalError += error;
	}

	const avgError = totalError / numTests;
	console.log(`   Average similarity error: ${avgError.toFixed(4)}`);
	console.log(`   Expected: ~0.1-0.3 for random embeddings`);
	console.log();

	// Test 3: Memory savings
	console.log("3. Memory Savings");
	const originalSize = dimensions * 4; // 4096 bytes
	const binarySize = Math.ceil(dimensions / 8); // 128 bytes
	console.log(`   Original (float32): ${originalSize} bytes`);
	console.log(`   Binary quantized: ${binarySize} bytes`);
	console.log(`   Savings: ${((1 - binarySize / originalSize) * 100).toFixed(1)}%`);
	console.log(`   Compression: ${(originalSize / binarySize).toFixed(1)}x`);
	console.log();

	// Test 4: Database storage estimate
	console.log("4. Database Storage Estimate");
	const numDocs = 10000;
	const dbOriginalSize = (numDocs * originalSize) / (1024 * 1024); // MB
	const dbBinarySize = (numDocs * binarySize) / (1024 * 1024); // MB
	console.log(`   For ${numDocs.toLocaleString()} documents:`);
	console.log(`   Original: ~${dbOriginalSize.toFixed(1)} MB`);
	console.log(`   Binary: ~${dbBinarySize.toFixed(1)} MB`);
	console.log(`   Saved: ~${(dbOriginalSize - dbBinarySize).toFixed(1)} MB`);
	console.log();

	console.log("=== Benchmark Complete ===");
}

main().catch(console.error);
