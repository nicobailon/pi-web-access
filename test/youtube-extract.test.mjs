import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const youtubeExtractUrl = new URL("../youtube-extract.ts", import.meta.url).href;
const extractUrl = new URL("../extract.ts", import.meta.url).href;

async function runModule(script) {
	const tmpDir = await mkdtemp(join(tmpdir(), "pi-web-access-test-"));
	const tmpFile = join(tmpDir, "test.mts");
	try {
		await writeFile(tmpFile, script);
		return spawnSync("npx", ["tsx", tmpFile], {
			encoding: "utf8",
			timeout: 30000,
			maxBuffer: 2 * 1024 * 1024,
		});
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

// ── Test: extractYouTube returns null for non-YouTube URL ────────────────────

test("extractYouTube returns null for non-YouTube URL", async () => {
	const child = await runModule(`
		import { extractYouTube } from ${JSON.stringify(youtubeExtractUrl)};
		const result = await extractYouTube("https://example.com/not-youtube");
		console.log(JSON.stringify({ isNull: result === null }));
	`);

	assert.equal(child.status, 0, `extractYouTube failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.isNull, true, "Should return null for non-YouTube URL");
});

// ── Test: isYouTubeURL correctly identifies YouTube URLs ─────────────────────

test("isYouTubeURL correctly identifies YouTube URLs", async () => {
	const child = await runModule(`
		import { isYouTubeURL } from ${JSON.stringify(youtubeExtractUrl)};
		const tests = [
			["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
			["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
			["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
			["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
			["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
			["https://example.com/video", null],
			["not-a-url", null],
		];
		const results = tests.map(([url, expectedVideoId]) => {
			const parsed = isYouTubeURL(url);
			return {
				url: url,
				videoId: parsed.videoId,
				expected: expectedVideoId,
				pass: parsed.videoId === expectedVideoId
			};
		});
		console.log(JSON.stringify(results));
	`);

	assert.equal(child.status, 0, `isYouTubeURL test failed: ${child.stderr}`);
	const outputs = JSON.parse(child.stdout.trim());
	for (const o of outputs) {
		assert.equal(o.pass, true, `isYouTubeURL failed for ${o.url}: got ${o.videoId}, expected ${o.expected}`);
	}
});

// ── Test: getYouTubeStreamInfo handles non-existent video ────────────────────

test("getYouTubeStreamInfo returns error for non-existent video", async () => {
	const child = await runModule(`
		import { getYouTubeStreamInfo } from ${JSON.stringify(youtubeExtractUrl)};
		const result = await getYouTubeStreamInfo("nonexistentvideo12345");
		console.log(JSON.stringify({
			hasError: "error" in result,
			error: "error" in result ? result.error : null
		}));
	`);

	assert.equal(child.status, 0, `getYouTubeStreamInfo failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.hasError, true, "Should return error for non-existent video");
});

// ── Test: extractYouTube respects abort signal ───────────────────────────────

test("extractYouTube respects abort signal", async () => {
	const child = await runModule(`
		import { extractYouTube } from ${JSON.stringify(youtubeExtractUrl)};
		const controller = new AbortController();
		controller.abort();
		const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", controller.signal);
		console.log(JSON.stringify({ isNull: result === null }));
	`);

	assert.equal(child.status, 0, `extractYouTube abort test failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.isNull, true, "Should return null when aborted immediately");
});

// ── Test: extractHeadingTitle works correctly ────────────────────────────────

test("extractHeadingTitle extracts heading from text", async () => {
	const child = await runModule(`
		import { extractHeadingTitle } from ${JSON.stringify(extractUrl)};
		const tests = [
			["# Video Title Here", "Video Title Here"],
			["## Another Title", "Another Title"],
			["No heading in this text", null],
			["", null],
		];
		const results = tests.map(([text, expected]) => {
			const actual = extractHeadingTitle(text);
			return { text: text.substring(0, 30), expected, actual, pass: actual === expected };
		});
		console.log(JSON.stringify(results));
	`);

	assert.equal(child.status, 0, `extractHeadingTitle test failed: ${child.stderr}`);
	const outputs = JSON.parse(child.stdout.trim());
	for (const o of outputs) {
		assert.equal(o.pass, true, `extractHeadingTitle failed for "${o.text}": got "${o.actual}", expected "${o.expected}"`);
	}
});
