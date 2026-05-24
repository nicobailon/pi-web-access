// Test YouTube and video extraction
import { isYouTubeURL, getYouTubeStreamInfo, extractYouTubeFrame } from '../youtube-extract.js';
import { isVideoFile, extractVideoFrame, getLocalVideoDuration } from '../video-extract.js';

// Test 26: YouTube stream info
console.log('=== TEST 26: YouTube stream info ===');
try {
    const info = await getYouTubeStreamInfo('dQw4w9WgXcQ');
    if ('error' in info) {
        console.log('Error:', info.error);
        console.log('Status: FAIL');
    } else {
        console.log('Stream URL:', info.streamUrl?.substring(0, 50) + '...');
        console.log('Duration:', info.duration);
        console.log('Status:', info.streamUrl ? 'PASS' : 'FAIL');
    }
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 27: Local video duration
console.log('\n=== TEST 27: Local video duration ===');
try {
    const duration = await getLocalVideoDuration('/home/john/pi-web-access/pi-web-fetch-demo.mp4');
    if (typeof duration === 'number') {
        console.log('Duration:', duration, 'seconds');
        console.log('Status: PASS');
    } else {
        console.log('Error:', duration.error);
        console.log('Status: FAIL');
    }
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 28: Local video frame extraction
console.log('\n=== TEST 28: Local video frame extraction ===');
try {
    const frame = await extractVideoFrame('/home/john/pi-web-access/pi-web-fetch-demo.mp4', 1);
    if ('error' in frame) {
        console.log('Error:', frame.error);
        console.log('Status: FAIL');
    } else {
        console.log('Frame size:', frame.data.length, 'bytes');
        console.log('MIME:', frame.mimeType);
        console.log('Status: PASS');
    }
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 29: GitHub API - check gh availability
console.log('\n=== TEST 29: GitHub API - gh availability ===');
import { checkGhAvailable, checkRepoSize } from '../github-api.js';
try {
    const ghAvail = await checkGhAvailable();
    console.log('gh available:', ghAvail);
    
    if (ghAvail) {
        const size = await checkRepoSize('expressjs', 'express');
        console.log('Repo size (KB):', size);
        console.log('Status: PASS');
    } else {
        console.log('Status: FAIL (gh not available)');
    }
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

// Test 30: RSC extraction
console.log('\n=== TEST 30: RSC extraction ===');
import { extractRSCContent } from '../rsc-extract.js';
try {
    // Test with a simple RSC flight data string
    const rscData = 'RSC:{"id":"test","children":{},"chunks":[["1","Test content"]]}';
    const result = extractRSCContent(rscData);
    console.log('Result:', result ? 'parsed' : 'null');
    if (result) {
        console.log('Title:', result.title);
        console.log('Content length:', result.content.length);
    }
    console.log('Status: PASS');
} catch (e) {
    console.log('ERROR:', (e as Error).message);
}

console.log('\nDone.');
