/**
 * Test Nomic Embed v1.5 embeddings
 */

import { generateNomicEmbedding, generateNomicBatchedEmbeddings, cosineSimilarity } from './embedding-nomic.js';

const TEST_DOCS = [
    "The stock market experienced significant volatility today.",
    "Artificial intelligence continues to advance rapidly.",
    "Climate change impacts are becoming more severe.",
];

async function main() {
    console.log('Testing Nomic Embed v1.5 (256-dim Matryoshka)...\n');
    
    // Test single embedding
    console.log('1. Single embedding test:');
    const emb1 = await generateNomicEmbedding(TEST_DOCS[0]);
    console.log(`   Dimension: ${emb1.length}`);
    console.log(`   First 5 values: ${emb1.slice(0, 5).map(v => v.toFixed(4)).join(', ')}`);
    
    // Test batch embedding
    console.log('\n2. Batch embedding test:');
    const batchStart = performance.now();
    const batchEmbs = await generateNomicBatchedEmbeddings(TEST_DOCS);
    const batchTime = performance.now() - batchStart;
    console.log(`   Batch time: ${batchTime.toFixed(2)}ms for ${TEST_DOCS.length} docs`);
    console.log(`   Per doc: ${(batchTime / TEST_DOCS.length).toFixed(2)}ms`);
    
    // Test cosine similarity
    console.log('\n3. Cosine similarity test:');
    const sim12 = cosineSimilarity(emb1, batchEmbs[1]);
    const sim13 = cosineSimilarity(emb1, batchEmbs[2]);
    console.log(`   Sim(1,2): ${sim12.toFixed(4)}`);
    console.log(`   Sim(1,3): ${sim13.toFixed(4)}`);
    
    // Test binary quantization
    console.log('\n4. Binary quantization test:');
    const { quantize, dequantize, binaryCosineSimilarity } = await import('./binary-quantizer.js');
    const quant = quantize(new Float32Array(emb1));
    console.log(`   Binary size: ${quant.binary.length} bytes`);
    console.log(`   Compression: ${quant.compressionRatio.toFixed(1)}x`);
    
    const dequant = dequantize(quant.binary);
    const sim = binaryCosineSimilarity(quant.binary, quant.binary);
    console.log(`   Self-similarity: ${sim.similarity.toFixed(4)} (should be 1.0)`);
    
    console.log('\nAll tests passed!');
}

main().catch(console.error);
