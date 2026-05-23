/**
 * Test Nomic Embed v1.5 embeddings
 */

import { generateNomicEmbedding, generateNomicBatchedEmbeddings, cosineSimilarity } from './embedding-nomic.js';
import { strict as assert } from 'node:assert';

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
    assert.strictEqual(emb1.length, 256, `Expected 256-dim embedding, got ${emb1.length}`);
    console.log(`   Dimension: ${emb1.length} ✓`);
    console.log(`   First 5 values: ${emb1.slice(0, 5).map(v => v.toFixed(4)).join(', ')}`);
    
    // Verify L2 normalization
    const norm = Math.sqrt(emb1.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(norm - 1.0) < 0.001, `Embedding not normalized: norm=${norm}`);
    console.log(`   L2 norm: ${norm.toFixed(6)} (should be ~1.0) ✓`);
    
    // Test batch embedding
    console.log('\n2. Batch embedding test:');
    const batchStart = performance.now();
    const batchEmbs = await generateNomicBatchedEmbeddings(TEST_DOCS);
    const batchTime = performance.now() - batchStart;
    assert.strictEqual(batchEmbs.length, TEST_DOCS.length, `Expected ${TEST_DOCS.length} embeddings, got ${batchEmbs.length}`);
    batchEmbs.forEach((emb, i) => {
        assert.strictEqual(emb.length, 256, `Embedding ${i} has wrong dimension: ${emb.length}`);
    });
    console.log(`   Batch time: ${batchTime.toFixed(2)}ms for ${TEST_DOCS.length} docs ✓`);
    console.log(`   Per doc: ${(batchTime / TEST_DOCS.length).toFixed(2)}ms`);
    
    // Test cosine similarity
    console.log('\n3. Cosine similarity test:');
    const sim12 = cosineSimilarity(emb1, batchEmbs[1]);
    const sim13 = cosineSimilarity(emb1, batchEmbs[2]);
    console.log(`   Sim(1,2): ${sim12.toFixed(4)}`);
    console.log(`   Sim(1,3): ${sim13.toFixed(4)}`);
    
    // Self-similarity should be 1.0
    const sim11 = cosineSimilarity(emb1, emb1);
    assert.ok(Math.abs(sim11 - 1.0) < 0.001, `Self-similarity should be ~1.0, got ${sim11}`);
    console.log(`   Self-similarity: ${sim11.toFixed(4)} ✓`);
    
    // Zero vector test
    const zeroVec = new Array(256).fill(0);
    const simZero = cosineSimilarity(zeroVec, emb1);
    assert.strictEqual(simZero, 0, `Zero vector similarity should be 0, got ${simZero}`);
    console.log(`   Zero vector similarity: ${simZero} ✓`);
    
    // Test binary quantization
    console.log('\n4. Binary quantization test:');
    const { quantize, dequantize, binaryCosineSimilarity } = await import('./binary-quantizer.js');
    const quant = quantize(new Float32Array(emb1));
    assert.strictEqual(quant.binary.length, 32, `Expected 32 bytes binary, got ${quant.binary.length}`);
    console.log(`   Binary size: ${quant.binary.length} bytes ✓`);
    console.log(`   Compression: ${quant.compressionRatio.toFixed(1)}x`);
    
    const dequant = dequantize(quant.binary);
    assert.strictEqual(dequant.length, 256, `Dequantized embedding should be 256-dim, got ${dequant.length}`);
    const sim = binaryCosineSimilarity(quant.binary, quant.binary);
    assert.ok(Math.abs(sim.similarity - 1.0) < 0.001, `Self-similarity should be 1.0, got ${sim.similarity}`);
    console.log(`   Self-similarity: ${sim.similarity.toFixed(4)} (should be 1.0) ✓`);
    
    console.log('\nAll tests passed!');
}

main().catch((err) => {
    console.error('Test failed:', err.message);
    process.exit(1);
});
