import { extractContent } from '../extract.js';
import { exaPipeline } from '../exa-pipeline.js';
import { generateNomicEmbedding, cosineSimilarity } from '../embedding-nomic.js';
import { addDocument, searchSimilar, getDocumentCount, clearDocuments } from '../exa-vector-db.js';

// Test 11: fetch_content - GitHub repo
console.log('=== TEST 11: fetch_content - GitHub repo ===');
try {
    const result = await extractContent('https://github.com/expressjs/express');
    console.log('Title:', result.title?.substring(0, 50));
    console.log('Content length:', result.content.length);
    console.log('Error:', result.error);
    console.log('Status:', result.content.length > 100 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 12: fetch_content - GitHub blob
console.log('\n=== TEST 12: fetch_content - GitHub blob ===');
try {
    const result = await extractContent('https://github.com/expressjs/express/blob/main/README.md');
    console.log('Title:', result.title?.substring(0, 50));
    console.log('Content length:', result.content.length);
    console.log('Error:', result.error);
    console.log('Status:', result.content.length > 100 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 13: Nomic Embedding
console.log('\n=== TEST 13: Nomic Embedding ===');
try {
    const embedding = await generateNomicEmbedding('test embedding');
    console.log('Embedding length:', embedding.length);
    console.log('First 5 values:', embedding.slice(0, 5).map(v => v.toFixed(4)));
    console.log('Norm:', Math.sqrt(embedding.reduce((s, v) => s + v * v, 0)).toFixed(4));
    console.log('Status:', embedding.length === 256 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 14: Vector DB
console.log('\n=== TEST 14: Vector DB ===');
try {
    clearDocuments();
    console.log('Clear count:', getDocumentCount());
    
    addDocument({
        id: 'test1',
        url: 'https://example.com/1',
        title: 'Test Document 1',
        content: 'This is a test document about web scraping',
        embedding: await generateNomicEmbedding('test document 1'),
    });
    addDocument({
        id: 'test2',
        url: 'https://example.com/2',
        title: 'Test Document 2',
        content: 'This is another document about machine learning',
        embedding: await generateNomicEmbedding('test document 2'),
    });
    console.log('After adding 2 docs:', getDocumentCount());
    
    const queryEmbedding = await generateNomicEmbedding('web scraping tools');
    const results = searchSimilar(queryEmbedding, 5);
    console.log('Query results:', results.length);
    for (const r of results) {
        console.log(`  ${r.document.title}: ${r.similarity.toFixed(4)}`);
    }
    console.log('Status:', results.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 15: Cosine similarity
console.log('\n=== TEST 15: Cosine similarity ===');
try {
    const a = await generateNomicEmbedding('hello world');
    const b = await generateNomicEmbedding('hello world');
    const c = await generateNomicEmbedding('completely different topic');
    console.log('Self-similarity:', cosineSimilarity(a, b).toFixed(4));
    console.log('Different-similarity:', cosineSimilarity(a, c).toFixed(4));
    console.log('Status:', cosineSimilarity(a, b) > 0.9 && cosineSimilarity(a, c) < 0.9 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

console.log('\nDone.');
