import { exaPipeline } from './exa-pipeline.js';

async function main() {
    console.log('=== Testing Exa Pipeline ===\n');
    const query = 'latest advances in AI model compression techniques 2026';
    console.log('Query:', query, '\n');
    
    const result = await exaPipeline(query, {
        numResults: 5,
        enableVectorSearch: false,
        enableReranking: false,
        enableSummaries: false,
        enableIndexing: false,
    });
    
    console.log('\n=== Results ===');
    console.log('Vector Count:', result.vectorCount);
    console.log('Processing Time:', result.processingTime, 'ms');
    console.log('Results:', result.results.length);
    
    result.results.slice(0, 3).forEach((r, i) => {
        console.log(i + 1 + '.', r.title);
        console.log('   ', r.url);
    });
}

main();
