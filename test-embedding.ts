import { generateEmbedding } from './local-llm-api.js';

async function main() {
    console.log('Testing embedding generation...');
    const start = Date.now();
    
    try {
        const emb = await generateEmbedding('Test embedding for compression');
        const elapsed = Date.now() - start;
        console.log('Embedding length:', emb.length);
        console.log('Time:', elapsed, 'ms');
        console.log('First 5 values:', emb.slice(0, 5));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

main();
