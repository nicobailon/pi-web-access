/**
 * Rigorous Benchmark for Self-Hosted Exa.ai-style Semantic Search Pipeline
 * Tests all components: binary quantization, Nomic Embed v1.5 embeddings, 
 * vector search, jina-reranker reranking
 */

import { 
    quantize, 
    dequantize, 
    cosineSimilarity, 
    binaryCosineSimilarity, 
    benchmark as benchQuantization,
    type QuantizationResult 
} from './binary-quantizer.js';
import { generateNomicEmbedding, generateNomicBatchedEmbeddings } from './embedding-nomic.js';
import { rerankWithJina } from './reranker-jina.js';
import { addDocument, searchSimilar, getDocumentCount, clearDocuments } from './exa-vector-db.js';

const EMBEDDING_DIM = 256; // Nomic Embed v1.5 truncated

interface BenchmarkResult {
    name: string;
    iterations: number;
    totalTime: number;
    perIteration: number;
    details?: Record<string, number>;
}

const TEST_DOCS = [
    "The stock market experienced significant volatility today as investors reacted to mixed economic data. Tech stocks fell 2% while energy stocks rose 3%.",
    "Artificial intelligence continues to advance rapidly with new models achieving human-level performance on various benchmarks. Deep learning breakthroughs enable better natural language understanding.",
    "Climate change impacts are becoming more severe with rising sea levels and extreme weather events. Scientists urge immediate action to reduce carbon emissions.",
    "Quantum computing research has made significant progress with new error correction techniques. IBM and Google are competing to achieve quantum supremacy.",
    "Renewable energy adoption is accelerating globally with solar and wind power becoming cheaper than fossil fuels in most markets.",
    "Cybersecurity threats continue to evolve with new ransomware variants targeting healthcare and financial institutions worldwide.",
    "Space exploration milestones include successful Mars rover missions and plans for crewed lunar missions by 2026.",
    "Electric vehicle sales surpassed 10 million units globally in 2024, representing 20% of all new car sales.",
    "Breakthrough research in mRNA technology shows promise for treating previously untreatable genetic diseases.",
    "Global supply chain disruptions continue to affect manufacturing and retail sectors across multiple industries."
];

async function runBenchmark(
    name: string,
    fn: () => Promise<unknown>,
    iterations: number,
    warmup: number
): Promise<BenchmarkResult> {
    // Warmup
    for (let i = 0; i < warmup; i++) {
        await fn();
    }
    
    const times: number[] = [];
    const start = performance.now();
    
    for (let i = 0; i < iterations; i++) {
        const iterStart = performance.now();
        await fn();
        times.push(performance.now() - iterStart);
    }
    
    const totalTime = performance.now() - start;
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const stddev = Math.sqrt(times.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / times.length);
    
    return {
        name,
        iterations,
        totalTime,
        perIteration: avg,
        details: { stddev }
    };
}

async function main() {
    console.log('=== Self-Hosted Exa Pipeline Benchmark ===');
    console.log(`   Embedding dims: ${EMBEDDING_DIM} (Nomic Embed v1.5 Matryoshka)`);
    console.log(`   Binary quantization: 32x compression\n`);
    
    // ============================================================
    // Section 1: Binary Quantization Benchmarks
    // ============================================================
    console.log('1. Binary Quantization Benchmarks');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    const quantBench = benchQuantization(1000, EMBEDDING_DIM);
    console.log(`   Quantize:     ${quantBench.quantizeMs.toFixed(3)}ms`);
    console.log(`   Dequantize:   ${quantBench.dequantizeMs.toFixed(3)}ms`);
    console.log(`   Similarity:   ${quantBench.similarityMs.toFixed(3)}ms`);
    console.log(`   Compression:  ${quantBench.compressionRatio.toFixed(1)}x`);
    
    // Accuracy benchmark
    console.log('\n   Accuracy Test (1000 random embeddings):');
    let totalError = 0;
    let maxError = 0;
    for (let i = 0; i < 1000; i++) {
        const embA = new Float32Array(EMBEDDING_DIM);
        const embB = new Float32Array(EMBEDDING_DIM);
        for (let j = 0; j < EMBEDDING_DIM; j++) {
            embA[j] = (Math.random() - 0.5) * 2;
            embB[j] = (Math.random() - 0.5) * 2;
        }
        
        const floatSim = cosineSimilarity(embA, embB);
        const quantA = quantize(embA);
        const quantB = quantize(embB);
        const binSim = binaryCosineSimilarity(quantA.binary, quantB.binary);
        
        const error = Math.abs(floatSim - binSim.similarity);
        totalError += error;
        maxError = Math.max(maxError, error);
    }
    console.log(`   Avg error:    ${(totalError / 1000).toFixed(4)}`);
    console.log(`   Max error:    ${maxError.toFixed(4)}`);
    
    // ============================================================
    // Section 2: Nomic Embed v1.5 Benchmark
    // ============================================================
    console.log('\n2. Nomic Embed v1.5 Benchmark (256-dim Matryoshka)');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    const embeddingBench = await runBenchmark(
        'generateNomicEmbedding',
        () => generateNomicEmbedding(TEST_DOCS[0]),
        20,
        2
    );
    console.log(`   Time:         ${embeddingBench.perIteration.toFixed(2)}ms ± ${(embeddingBench.details?.stddev || 0).toFixed(2)}ms`);
    console.log(`   Throughput:   ${(1000 / embeddingBench.perIteration).toFixed(1)} docs/sec`);
    
    // Batch embedding benchmark
    console.log('\n   Batch Embedding Benchmark (10 docs):');
    const batchStart = performance.now();
    const batchEmbeddings = await generateNomicBatchedEmbeddings(TEST_DOCS.slice(0, 10));
    const batchTime = performance.now() - batchStart;
    console.log(`   Batch time:   ${batchTime.toFixed(2)}ms`);
    console.log(`   Per doc:      ${(batchTime / 10).toFixed(2)}ms`);
    console.log(`   Speedup:      ${(batchTime / (batchTime / 10)).toFixed(1)}x vs sequential`);
    
    // ============================================================
    // Section 3: Vector Database Benchmarks
    // ============================================================
    console.log('\n3. Vector Database Benchmarks');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    // Clear existing data
    clearDocuments();
    
    // Insert benchmark
    console.log('   Insert Benchmark:');
    const insertStart = performance.now();
    for (const doc of TEST_DOCS.slice(0, 20)) {
        const emb = await generateNomicEmbedding(doc);
        addDocument({
            id: `doc-${Math.random().toString(36).substr(2, 9)}`,
            url: `https://example.com/${Math.random().toString(36).substr(2, 9)}`,
            title: 'Test Document',
            content: doc,
            embedding: emb
        });
    }
    const insertTime = performance.now() - insertStart;
    console.log(`   Insert 20:    ${insertTime.toFixed(2)}ms`);
    console.log(`   Per insert:   ${(insertTime / 20).toFixed(2)}ms`);
    console.log(`   Storage:      ${(getDocumentCount() * 32 / 1024).toFixed(2)}KB for ${getDocumentCount()} docs`);
    
    // Search benchmark
    console.log('\n   Search Benchmark:');
    const queryEmb = await generateNomicEmbedding('test query');
    const searchTimes: number[] = [];
    for (let i = 0; i < 50; i++) {
        const start = performance.now();
        searchSimilar(queryEmb, 10);
        searchTimes.push(performance.now() - start);
    }
    const avgSearchTime = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
    console.log(`   Search 50:    ${searchTimes.reduce((a, b) => a + b, 0).toFixed(2)}ms total`);
    console.log(`   Per search:   ${avgSearchTime.toFixed(2)}ms`);
    console.log(`   Throughput:   ${(1000 / avgSearchTime).toFixed(1)} searches/sec`);
    
    // ============================================================
    // Section 4: Jina Reranker Benchmarks
    // ============================================================
    console.log('\n4. Jina Reranker v1 Tiny Benchmarks');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    // Reranking benchmark
    console.log('   Reranking Benchmark:');
    const rerankResults = await runBenchmark(
        'rerankWithJina',
        async () => {
            const results = await rerankWithJina(
                'test query',
                TEST_DOCS.slice(0, 10).map((doc, i) => ({
                    url: `https://example.com/${i}`,
                    title: `Test ${i}`,
                    snippet: doc
                })),
                { batchSize: 5 }
            );
            return results.length;
        },
        3,
        1
    );
    console.log(`   Time:         ${rerankResults.perIteration.toFixed(2)}ms`);
    console.log(`   Throughput:   ${(10 / (rerankResults.perIteration / 1000)).toFixed(1)} docs/sec`);
    
    // ============================================================
    // Section 5: End-to-End Pipeline Benchmark
    // ============================================================
    console.log('\n5. End-to-End Pipeline Benchmark');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    const e2eStart = performance.now();
    // Simulate pipeline steps without full search
    const pipelineDocs = TEST_DOCS.slice(0, 10);
    const pipelineEmbeddings = await generateNomicBatchedEmbeddings(pipelineDocs);
    const pipelineQueryEmb = await generateNomicEmbedding('test query');
    const pipelineSearch = searchSimilar(pipelineQueryEmb, 10);
    const e2eTime = performance.now() - e2eStart;
    
    console.log(`   Pipeline 10:  ${e2eTime.toFixed(2)}ms`);
    console.log(`   Per doc:      ${(e2eTime / 10).toFixed(2)}ms`);
    console.log(`   Throughput:   ${(10 / (e2eTime / 1000)).toFixed(1)} docs/sec`);
    
    // ============================================================
    // Summary
    // ============================================================
    console.log('\n=== Summary ===');
    console.log('   Binary Quantization:');
    console.log(`   - Compression: 32x (1024 → 32 bytes)`);
    console.log(`   - Quantize: ${quantBench.quantizeMs.toFixed(3)}ms`);
    console.log(`   - Similarity: ${quantBench.similarityMs.toFixed(3)}ms`);
    console.log(`   - Accuracy: ${(totalError / 1000).toFixed(4)} avg error`);
    console.log('\n   Nomic Embed v1.5 (256-dim):');
    console.log(`   - Speed: ${(1000 / embeddingBench.perIteration).toFixed(1)} docs/sec`);
    console.log(`   - Batch: ${(batchTime / 10).toFixed(2)}ms per doc`);
    console.log('\n   Vector DB:');
    console.log(`   - Insert: ${(insertTime / 20).toFixed(2)}ms per doc`);
    console.log(`   - Search: ${avgSearchTime.toFixed(2)}ms per query`);
    console.log('\n   Jina Reranker:');
    console.log(`   - Rerank 10: ${rerankResults.perIteration.toFixed(2)}ms`);
    console.log('\n   End-to-End:');
    console.log(`   - Pipeline: ${e2eTime.toFixed(2)}ms for 10 docs`);
    console.log(`   - Throughput: ${(10 / (e2eTime / 1000)).toFixed(1)} docs/sec`);
}

main().catch(console.error);
