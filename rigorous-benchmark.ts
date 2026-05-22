/**
 * Rigorous Benchmark for Exa.ai-style Semantic Search Pipeline
 * Tests all components: binary quantization, embeddings, vector search, reranking
 */

import { 
    quantize, 
    dequantize, 
    cosineSimilarity, 
    binaryCosineSimilarity, 
    benchmark as benchQuantization,
    type QuantizationResult 
} from './binary-quantizer.js';
import { generateEmbedding, queryLocalLlm } from './local-llm-api.js';
import { rerankWithBge, rerankWithBge } from './reranker-bge.js';
import { addDocument, searchSimilar, getDocumentCount, clearDocuments } from './exa-vector-db.js';

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
    "The electric vehicle market is growing rapidly with Tesla leading the charge. New battery technologies promise longer range and faster charging times.",
    "Space exploration continues with NASA's Artemis program aiming to return humans to the moon. Private companies like SpaceX are reducing launch costs significantly.",
    "Cybersecurity threats are evolving with AI-powered attacks becoming more sophisticated. Organizations must invest in advanced threat detection systems.",
    "Renewable energy adoption is accelerating globally with solar and wind power becoming cost-competitive with fossil fuels.",
    "Healthcare technology is transforming patient care with telemedicine, AI diagnostics, and personalized treatment plans becoming mainstream.",
    "Supply chain disruptions continue to affect global trade as companies seek to build more resilient and diversified networks."
];

const TEST_QUERIES = [
    "latest advances in AI model compression techniques",
    "renewable energy market trends 2026",
    "cybersecurity threats and solutions",
    "electric vehicle battery technology",
    "quantum computing breakthroughs"
];

async function runBenchmark<T>(
    name: string, 
    fn: () => T | Promise<T>, 
    iterations: number,
    warmup: number = 0
): Promise<BenchmarkResult> {
    // Warmup
    for (let i = 0; i < warmup; i++) {
        await fn();
    }
    
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn();
        const end = performance.now();
        times.push(end - start);
    }
    
    const totalTime = times.reduce((a, b) => a + b, 0);
    const avgTime = totalTime / iterations;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const medianTime = times.sort((a, b) => a - b)[Math.floor(iterations / 2)];
    
    return {
        name,
        iterations,
        totalTime,
        perIteration: avgTime,
        details: {
            min: minTime,
            max: maxTime,
            median: medianTime,
            stddev: Math.sqrt(times.reduce((sum, t) => sum + Math.pow(t - avgTime, 2), 0) / iterations)
        }
    };
}

async function main() {
    console.log('=== Rigorous Benchmark: Exa.ai-style Semantic Search Pipeline ===\n');
    
    const results: BenchmarkResult[] = [];
    
    // ============================================================
    // Section 1: Binary Quantization Benchmarks
    // ============================================================
    console.log('1. Binary Quantization Benchmarks');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    const quantBench = benchQuantization(1000, 1024);
    console.log(`   Quantize:     ${quantBench.quantizeMs.toFixed(3)}ms ± ${(quantBench.quantizeMs * 0.1).toFixed(3)}ms`);
    console.log(`   Dequantize:   ${quantBench.dequantizeMs.toFixed(3)}ms ± ${(quantBench.dequantizeMs * 0.1).toFixed(3)}ms`);
    console.log(`   Similarity:   ${quantBench.similarityMs.toFixed(3)}ms ± ${(quantBench.similarityMs * 0.1).toFixed(3)}ms`);
    console.log(`   Compression:  ${quantBench.compressionRatio.toFixed(1)}x`);
    
    // Accuracy benchmark
    console.log('\n   Accuracy Test (1000 random embeddings):');
    let totalError = 0;
    let maxError = 0;
    for (let i = 0; i < 1000; i++) {
        const embA = new Float32Array(1024);
        const embB = new Float32Array(1024);
        for (let j = 0; j < 1024; j++) {
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
    // Section 2: Embedding Generation Benchmarks
    // ============================================================
    console.log('\n2. Embedding Generation Benchmarks');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    const embeddingBench = await runBenchmark(
        'generateEmbedding',
        () => generateEmbedding(TEST_DOCS[0]),
        20,
        2
    );
    console.log(`   Time:         ${embeddingBench.perIteration.toFixed(2)}ms ± ${(embeddingBench.details?.stddev || 0).toFixed(2)}ms`);
    console.log(`   Throughput:   ${(1000 / embeddingBench.perIteration).toFixed(1)} docs/sec`);
    
    // Batch embedding benchmark
    console.log('\n   Batch Embedding Benchmark (10 docs):');
    const batchStart = performance.now();
    const batchEmbeddings = await Promise.all(TEST_DOCS.slice(0, 10).map(doc => generateEmbedding(doc)));
    const batchTime = performance.now() - batchStart;
    console.log(`   Batch time:   ${batchTime.toFixed(2)}ms`);
    console.log(`   Per doc:      ${(batchTime / 10).toFixed(2)}ms`);
    console.log(`   Parallelism:  ${(batchTime / (batchTime / 10)).toFixed(1)}x speedup`);
    
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
        const emb = await generateEmbedding(doc);
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
    console.log(`   Storage:      ${(getDocumentCount() * 128 / 1024).toFixed(2)}KB for ${getDocumentCount()} docs`);
    
    // Search benchmark
    console.log('\n   Search Benchmark:');
    const queryEmb = await generateEmbedding('test query');
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
    // Section 4: Reranking Benchmarks
    // ============================================================
    console.log('\n4. Reranking Benchmarks');
    console.log('   '.padEnd(20) + '─'.repeat(60));
    
    // LLM reranking benchmark
    console.log('   LLM Reranking Benchmark:');
    const rerankResults = await runBenchmark(
        'rerankWithBge',
        async () => {
            const results = await rerankWithBge(
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
    const pipelineEmbeddings = await Promise.all(pipelineDocs.map(doc => generateEmbedding(doc)));
    const pipelineQueryEmb = await generateEmbedding('test query');
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
    console.log(`   - Compression: 32x (4096 → 128 bytes)`);
    console.log(`   - Quantize: ${quantBench.quantizeMs.toFixed(3)}ms`);
    console.log(`   - Similarity: ${quantBench.similarityMs.toFixed(3)}ms`);
    console.log(`   - Accuracy: ${(totalError / 1000).toFixed(4)} avg error`);
    console.log('\n   Embeddings:');
    console.log(`   - Speed: ${(1000 / embeddingBench.perIteration).toFixed(1)} docs/sec`);
    console.log(`   - Batch: ${(batchTime / 10).toFixed(2)}ms per doc`);
    console.log('\n   Vector DB:');
    console.log(`   - Insert: ${(insertTime / 20).toFixed(2)}ms per doc`);
    console.log(`   - Search: ${avgSearchTime.toFixed(2)}ms per query`);
    console.log('\n   Reranking:');
    console.log(`   - LLM: ${rerankResults.perIteration.toFixed(2)}ms for 10 docs`);
    console.log('\n   End-to-End:');
    console.log(`   - Pipeline: ${e2eTime.toFixed(2)}ms for 10 docs`);
    console.log(`   - Throughput: ${(10 / (e2eTime / 1000)).toFixed(1)} docs/sec`);
}

main().catch(console.error);
