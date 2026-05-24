// Test storage and search content
import { generateId, storeResult, getResult, getAllResults, deleteResult, clearResults, restoreFromSession } from '../storage.js';
import { exaPipeline } from '../exa-pipeline.js';

// Test 16: Storage
console.log('=== TEST 16: Storage ===');
try {
    clearResults();
    const id = generateId();
    console.log('Generated ID:', id);
    
    storeResult(id, {
        id,
        type: 'search',
        timestamp: Date.now(),
        queries: [{
            query: 'test query',
            answer: 'test answer',
            results: [{ title: 'Test', url: 'https://test.com', snippet: 'test snippet' }],
            error: null,
        }],
    });
    
    const result = getResult(id);
    console.log('Retrieved:', result ? 'yes' : 'no');
    console.log('Query count:', result?.queries?.length || 0);
    
    const all = getAllResults();
    console.log('All results:', all.length);
    
    deleteResult(id);
    console.log('After delete:', getAllResults().length);
    
    console.log('Status:', getAllResults().length === 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 17: Exa Pipeline (basic)
console.log('\n=== TEST 17: Exa Pipeline ===');
try {
    const result = await exaPipeline('web scraping tools', {
        numResults: 5,
        enableVectorSearch: false,
        enableReranking: false,
        enableSummaries: false,
        enableIndexing: false,
    });
    console.log('Results count:', result.results.length);
    console.log('Vector count:', result.vectorCount);
    console.log('Processing time:', result.processingTime, 'ms');
    for (const r of result.results.slice(0, 3)) {
        console.log(`  ${r.title.substring(0, 50)}: score=${r.score.toFixed(3)}`);
    }
    console.log('Status:', result.results.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 18: PDF extraction
console.log('\n=== TEST 18: PDF extraction ===');
import { isPDF, extractPDFToMarkdown } from '../pdf-extract.js';
try {
    // Test PDF detection
    console.log('PDF URL detection:', isPDF('https://example.com/document.pdf', 'application/pdf'));
    console.log('HTML URL detection:', isPDF('https://example.com/page', 'text/html'));
    console.log('Status: PASS');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 19: Reranker
console.log('\n=== TEST 19: Reranker ===');
import { rerankWithJina } from '../reranker-jina.js';
try {
    const results = await rerankWithJina('web scraping', [
        { url: 'https://example.com/1', title: 'Web Scraping Guide', snippet: 'A comprehensive guide to web scraping' },
        { url: 'https://example.com/2', title: 'Cooking Recipes', snippet: 'Delicious recipes for everyone' },
        { url: 'https://example.com/3', title: 'Scraping Tools', snippet: 'Best tools for web scraping in 2025' },
    ]);
    console.log('Reranked results:', results.length);
    for (const r of results) {
        console.log(`  ${r.title}: score=${r.score.toFixed(3)}`);
    }
    console.log('Status:', results.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

console.log('\nDone.');
