// Final comprehensive test - test all remaining features
import { extractContent } from '../extract.js';
import { computeRangeTimestamps } from '../extract.js';

// Test: computeRangeTimestamps
console.log('=== TEST: computeRangeTimestamps ===');
console.log('Range 0-60, 6 frames:', computeRangeTimestamps(0, 60, 6));
console.log('Range 0-60, 1 frame:', computeRangeTimestamps(0, 60, 1));
console.log('Range 0-60, default:', computeRangeTimestamps(0, 60));
console.log('Range 0-10, 5 frames:', computeRangeTimestamps(0, 10, 5));

// Test: extractContent with various URL types
console.log('\n=== TEST: extractContent - various types ===');

// Test JSON
try {
    const result = await extractContent('https://httpbin.org/json');
    console.log('JSON:', result.content.length > 50 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('JSON: ERROR', (e as Error).message);
}

// Test text
try {
    const result = await extractContent('https://httpbin.org/get');
    console.log('GET:', result.content.length > 50 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('GET: ERROR', (e as Error).message);
}

// Test HTML
try {
    const result = await extractContent('https://httpbin.org/html');
    console.log('HTML:', result.content.length > 100 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('HTML: ERROR', (e as Error).message);
}

// Test: extractContent with Jina Reader fallback
console.log('\n=== TEST: extractContent - Jina fallback ===');
try {
    const result = await extractContent('https://httpbin.org/html');
    console.log('Content extracted:', result.content.length > 0 ? 'yes' : 'no');
    console.log('Error:', result.error || 'none');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

console.log('\nDone.');
