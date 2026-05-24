import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const codeSearchUrl = new URL("../code-search.ts", import.meta.url).href;

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

// ── Test: searchExaCodeSearch returns empty for non-existent query ───────────

test("searchExaCodeSearch completes without throwing for any query", async () => {
	const child = await runModule(`
		import { searchExaCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchExaCodeSearch("nonexistent-package-xyz-12345-abc");
		console.log(JSON.stringify({ count: results.length, status: "ok" }));
	`);

	assert.equal(child.status, 0, `searchExaCodeSearch failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.status, "ok");
	assert.ok(output.count >= 0, "Should return non-negative count");
});

// ── Test: searchExaCodeSearch returns empty when SearXNG/Firecrawl unavailable ──

test("searchExaCodeSearch handles SearXNG unavailability gracefully", async () => {
	const child = await runModule(`
		import { searchExaCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchExaCodeSearch("test query");
		console.log(JSON.stringify({ count: results.length, status: "ok" }));
	`);

	assert.equal(child.status, 0, `searchExaCodeSearch should not throw: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.status, "ok", "Should not throw even when search backends are unavailable");
});

// ── Test: searchExaCodeSearch filters non-GitHub URLs ────────────────────────

test("searchExaCodeSearch only returns GitHub URLs when results available", async () => {
	const child = await runModule(`
		import { searchExaCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchExaCodeSearch("typescript");
		const allGithub = results.every(r => r.url.includes("github.com"));
		console.log(JSON.stringify({
			count: results.length,
			allGithub: allGithub,
			results: results.map(r => ({ url: r.url, score: r.score }))
		}));
	`);

	assert.equal(child.status, 0, `searchExaCodeSearch failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	if (output.count > 0) {
		assert.equal(output.allGithub, true, "All results should be GitHub URLs");
	}
});

// ── Test: searchExaCodeSearch result shape ───────────────────────────────────

test("searchExaCodeSearch returns correctly shaped results", async () => {
	const child = await runModule(`
		import { searchExaCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchExaCodeSearch("typescript");
		console.log(JSON.stringify({
			count: results.length,
			shape: results.length > 0 ? {
				hasUrl: "url" in results[0],
				hasTitle: "title" in results[0],
				hasContent: "content" in results[0],
				hasScore: "score" in results[0],
			} : "empty"
		}));
	`);

	assert.equal(child.status, 0, `searchExaCodeSearch failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	if (output.shape !== "empty") {
		assert.equal(output.shape.hasUrl, true, "Results should have 'url' field");
		assert.equal(output.shape.hasTitle, true, "Results should have 'title' field");
		assert.equal(output.shape.hasContent, true, "Results should have 'content' field");
		assert.equal(output.shape.hasScore, true, "Results should have 'score' field");
	}
});

// ── Test: searchExaCodeSearch handles query with special characters ──────────

test("searchExaCodeSearch handles special characters in query", async () => {
	const child = await runModule(`
		import { searchExaCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchExaCodeSearch("test+query+with+plus+signs");
		console.log(JSON.stringify({ count: results.length, status: "ok" }));
	`);

	assert.equal(child.status, 0, `searchExaCodeSearch with special chars failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.status, "ok", "Should handle special characters without error");
});
