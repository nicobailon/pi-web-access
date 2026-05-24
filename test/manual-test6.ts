// Test browser stealth and local LLM
import { isBrowserStealthAvailable, stealthNavigate, stealthSnapshot, stealthTitle } from '../browser-stealth.js';
import { queryLocalLlm } from '../local-llm-api.js';

// Test 20: Browser stealth availability
console.log('=== TEST 20: Browser stealth ===');
try {
    const available = isBrowserStealthAvailable();
    console.log('Available:', available);
    console.log('Status:', available ? 'PASS' : 'FAIL (not installed)');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 21: Local LLM
console.log('\n=== TEST 21: Local LLM ===');
try {
    const result = await queryLocalLlm('What is 2+2? Answer with just the number.', { maxTokens: 10 });
    console.log('Response:', result?.substring(0, 50));
    console.log('Status:', result ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 22: GitHub API direct fetch
console.log('\n=== TEST 22: GitHub API direct fetch ===');
import { fetchViaApi } from '../github-api.js';
import { parseGitHubUrl } from '../github-extract.js';
try {
    const urlInfo = parseGitHubUrl('https://github.com/expressjs/express/blob/main/README.md');
    if (urlInfo) {
        const result = await fetchViaApi(
            'https://github.com/expressjs/express/blob/main/README.md',
            urlInfo.owner,
            urlInfo.repo,
            urlInfo
        );
        console.log('Title:', result?.title?.substring(0, 50));
        console.log('Content length:', result?.content?.length || 0);
        console.log('Error:', result?.error);
        console.log('Status:', result?.content?.length > 100 ? 'PASS' : 'FAIL');
    } else {
        console.log('Status: FAIL (could not parse URL)');
    }
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 23: Firefox content extraction (non-HTML)
console.log('\n=== TEST 23: fetch_content - text/plain ===');
import { extractContent } from '../extract.js';
try {
    const result = await extractContent('https://httpbin.org/status/200');
    console.log('Status code handled:', result.content.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 24: Error handling - invalid URL
console.log('\n=== TEST 24: Error handling - invalid URL ===');
try {
    const result = await extractContent('not-a-valid-url');
    console.log('Error message:', result.error);
    console.log('Status:', result.error === 'Invalid URL' ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 25: Error handling - 404
console.log('\n=== TEST 25: Error handling - 404 ===');
try {
    const result = await extractContent('https://httpbin.org/status/404');
    console.log('Error message:', result.error);
    console.log('Status:', result.error?.includes('404') ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

console.log('\nDone.');
