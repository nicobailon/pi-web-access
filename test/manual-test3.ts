import { isYouTubeURL } from '../youtube-extract.js';

// Test YouTube URL detection with proper 11-char IDs
console.log('=== YouTube URL detection (proper 11-char IDs) ===');
const testUrls = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/v/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
];

for (const url of testUrls) {
    const info = isYouTubeURL(url);
    console.log(`  ${url.substring(0, 60)}:`);
    console.log(`    isYouTube=${info.isYouTube}, videoId=${info.videoId}`);
}

// Test domain filter bug investigation
console.log('\n=== Domain filter investigation ===');
import { search } from '../firecrawl-search.js';
try {
    // Without filter
    const result1 = await search('web scraping', { numResults: 5 });
    console.log('Without filter:', result1.results.length, 'results');
    for (const r of result1.results) {
        console.log(`  - ${r.url}`);
    }

    // With exclusion filter
    const result2 = await search('web scraping', { numResults: 5, domainFilter: ['-github.com'] });
    console.log('With -github.com filter:', result2.results.length, 'results');
    for (const r of result2.results) {
        console.log(`  - ${r.url}`);
    }
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

console.log('\nDone.');
