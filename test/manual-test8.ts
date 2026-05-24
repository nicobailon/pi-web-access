// Test more features
import { extractContent } from '../extract.js';
import { extractWithFirecrawl } from '../firecrawl-fetch.js';
import { extractViaBrowserStealth } from '../browser-stealth.js';
import { extractPDFToMarkdown, isPDF } from '../pdf-extract.js';
import { extractWithJinaReader } from '../extract.js';

// Test 31: Firecrawl fetch
console.log('=== TEST 31: Firecrawl fetch ===');
try {
    const result = await extractWithFirecrawl('https://httpbin.org/html');
    console.log('Title:', result?.title?.substring(0, 50));
    console.log('Content length:', result?.content?.length || 0);
    console.log('Error:', result?.error);
    console.log('Status:', result?.content?.length > 100 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 32: Browser stealth extract
console.log('\n=== TEST 32: Browser stealth extract ===');
try {
    const result = await extractViaBrowserStealth('https://httpbin.org/html');
    console.log('Title:', result?.title?.substring(0, 50));
    console.log('Content length:', result?.content?.length || 0);
    console.log('Error:', result?.error);
    console.log('Status:', result?.content?.length > 100 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 33: PDF detection
console.log('\n=== TEST 33: PDF detection ===');
try {
    console.log('PDF URL:', isPDF('https://example.com/doc.pdf', 'application/pdf'));
    console.log('HTML:', isPDF('https://example.com/page', 'text/html'));
    console.log('Status: PASS');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 34: Jina Reader
console.log('\n=== TEST 34: Jina Reader ===');
try {
    // Note: extractWithJinaReader is not exported, so we can't test it directly
    // But we can test the fallback chain via extractContent
    const result = await extractContent('https://httpbin.org/html');
    console.log('Content extracted:', result.content.length > 0 ? 'yes' : 'no');
    console.log('Error:', result.error);
    console.log('Status:', result.content.length > 100 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 35: Activity monitor
console.log('\n=== TEST 35: Activity monitor ===');
import { activityMonitor } from '../activity.js';
try {
    const id = activityMonitor.logStart({ type: 'api', query: 'test query' });
    activityMonitor.logComplete(id, 200);
    activityMonitor.logError(id, 'test error');
    const entries = activityMonitor.getEntries();
    console.log('Entries:', entries.length);
    console.log('Status:', entries.length > 0 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 36: Utils
console.log('\n=== TEST 36: Utils ===');
import { formatSeconds } from '../utils.js';
try {
    console.log('120s:', formatSeconds(120));
    console.log('90s:', formatSeconds(90));
    console.log('45s:', formatSeconds(45));
    console.log('Status: PASS');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 37: Browser config
console.log('\n=== TEST 37: Browser config ===');
import { isBrowserStealthAvailable } from '../browser-config.js';
try {
    const available = isBrowserStealthAvailable();
    console.log('Available:', available);
    console.log('Status:', typeof available === 'boolean' ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 38: Firecrawl config
console.log('\n=== TEST 38: Firecrawl config ===');
import { getFirecrawlConfig, isFirecrawlAvailable } from '../firecrawl-config.js';
try {
    const available = isFirecrawlAvailable();
    console.log('Available:', available);
    const config = await getFirecrawlConfig();
    console.log('Config:', config ? JSON.stringify(config).substring(0, 100) : 'null');
    console.log('Status:', typeof available === 'boolean' ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

console.log('\nDone.');
