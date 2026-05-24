import { fetchViaApi } from '../github-api.js';
import { parseGitHubUrl } from '../github-extract.js';

// Test GitHub API directly
console.log('=== TEST: GitHub API direct fetch ===');
const urlInfo = parseGitHubUrl('https://github.com/expressjs/express/blob/main/README.md');
console.log('Parsed:', JSON.stringify(urlInfo, null, 2));

if (urlInfo) {
    const result = await fetchViaApi(
        'https://github.com/expressjs/express/blob/main/README.md',
        urlInfo.owner,
        urlInfo.repo,
        urlInfo
    );
    console.log('Result:', result ? JSON.stringify({ title: result.title?.substring(0, 50), contentLen: result.content?.length, error: result.error }) : 'null');
    if (result && result.content) {
        console.log('First 200 chars:', result.content.substring(0, 200));
    }
}
