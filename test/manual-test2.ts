import { extractContent, fetchAllContent } from '../extract.js';
import { isYouTubeURL } from '../youtube-extract.js';
import { isVideoFile } from '../video-extract.js';
import { parseGitHubUrl, extractGitHub } from '../github-extract.js';
import { fetchViaApi } from '../github-api.js';

// Test 5: fetch_content - web page
console.log('=== TEST 5: fetch_content - web page ===');
try {
    const result = await extractContent('https://httpbin.org/html');
    console.log('Title:', result.title?.substring(0, 50));
    console.log('Content length:', result.content.length);
    console.log('Error:', result.error);
    console.log('Status:', result.content.length > 100 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 6: fetch_content - JSON
console.log('\n=== TEST 6: fetch_content - JSON ===');
try {
    const result = await extractContent('https://httpbin.org/json');
    console.log('Title:', result.title?.substring(0, 50));
    console.log('Content length:', result.content.length);
    console.log('Error:', result.error);
    console.log('Status:', result.content.length > 50 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 7: fetch_content - multiple URLs
console.log('\n=== TEST 7: fetch_content - multiple URLs ===');
try {
    const results = await fetchAllContent(['https://httpbin.org/html', 'https://httpbin.org/json']);
    console.log('Results count:', results.length);
    console.log('Status:', results.length === 2 ? 'PASS' : 'FAIL');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 8: GitHub URL parsing
console.log('\n=== TEST 8: GitHub URL parsing ===');
const testUrls = [
    'https://github.com/expressjs/express',
    'https://github.com/expressjs/express/blob/main/README.md',
    'https://github.com/expressjs/express/tree/main/lib',
    'https://github.com/torvalds/linux/blob/master/README.md',
    'not-a-url',
];
for (const url of testUrls) {
    const parsed = parseGitHubUrl(url);
    console.log(`  ${url.substring(0, 60)}:`, parsed ? `ok (${parsed.type})` : 'null');
}

// Test 9: YouTube URL detection
console.log('\n=== TEST 9: YouTube URL detection ===');
const ytUrls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/abc123',
    'https://www.youtube.com/live/abc123',
    'https://www.youtube.com/playlist?list=abc',
    'not-a-youtube-url',
];
for (const url of ytUrls) {
    const info = isYouTubeURL(url);
    console.log(`  ${url.substring(0, 50)}:`, info.isYouTube ? `id=${info.videoId}` : 'not-youtube');
}

// Test 10: Video file detection
console.log('\n=== TEST 10: Video file detection ===');
const videoPaths = [
    '/home/john/pi-web-access/pi-web-fetch-demo.mp4',
    '/nonexistent/video.mp4',
    'https://example.com/video.mp4',
    '/home/john/pi-web-access/README.md',
];
for (const path of videoPaths) {
    const info = isVideoFile(path);
    console.log(`  ${path}:`, info ? `ok (${info.mimeType})` : 'not-video');
}

console.log('\nDone.');
