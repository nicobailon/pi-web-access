import { search } from '../firecrawl-search.js';
import { searchWithSearXNG } from '../searxng-search.js';

// Test 1: web_search single query
console.log('=== TEST 1: web_search single query ===');
try {
    const result = await search('TypeScript best practices 2025', { numResults: 3 });
    console.log('Provider:', result.provider);
    console.log('Answer length:', result.answer?.length || 0);
    console.log('Results count:', result.results.length);
    console.log('Status:', result.results.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', e.message);
}

// Test 2: web_search with recency filter
console.log('\n=== TEST 2: web_search recency filter ===');
try {
    const result = await search('JavaScript frameworks', { numResults: 3, recencyFilter: 'month' });
    console.log('Results count:', result.results.length);
    console.log('Status:', result.results.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', e.message);
}

// Test 3: web_search with domain filter
console.log('\n=== TEST 3: web_search domain filter ===');
try {
    const result = await search('web scraping', { numResults: 3, domainFilter: ['-github.com'] });
    console.log('Results count:', result.results.length);
    console.log('Status:', result.results.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', e.message);
}

// Test 4: SearXNG search
console.log('\n=== TEST 4: SearXNG search ===');
try {
    const result = await searchWithSearXNG('web scraping', { numResults: 3 });
    console.log('Results count:', result.results.length);
    console.log('Status:', result.results.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', e.message);
}

console.log('\nDone.');
