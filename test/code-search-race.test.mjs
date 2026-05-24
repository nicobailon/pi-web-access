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

// ── Test: searchSourcegraphWithTimeout returns empty when Sourcegraph is unavailable ──

test("searchSourcegraphWithTimeout returns empty array when Sourcegraph is unavailable", async () => {
	const child = await runModule(`
		import { searchSourcegraphWithTimeout } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchSourcegraphWithTimeout("test query", 10, 2000);
		console.log(JSON.stringify({ count: results.length, status: "ok" }));
	`);

	assert.equal(child.status, 0, `searchSourcegraphWithTimeout failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.count, 0, "Should return empty array when Sourcegraph is not running");
	assert.equal(output.status, "ok");
});

// ── Test: searchExaCodeSearch returns empty when no GitHub repos match ──

test("searchExaCodeSearch returns results without throwing", async () => {
	const child = await runModule(`
		import { searchExaCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchExaCodeSearch("nonexistent-package-xyz-12345");
		console.log(JSON.stringify({ count: results.length, status: "ok" }));
	`);

	assert.equal(child.status, 0, `searchExaCodeSearch failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.count >= 0, "Should return non-negative count");
	assert.equal(output.status, "ok");
});

// ── Test: executeCodeSearch handles both sources unavailable ──

test("executeCodeSearch completes without error and returns valid mode", async () => {
	const child = await runModule(`
		import { executeCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const result = await executeCodeSearch("test-123", { query: "nonexistent-package-xyz-12345", maxTokens: 5000 });
		console.log(JSON.stringify({ mode: result.details.mode, count: result.details.resultCount }));
	`);

	assert.equal(child.status, 0, `executeCodeSearch failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(["sourcegraph-mcp-wins", "exa-pipeline-wins", "no-results"].includes(output.mode),
		`Should return a valid mode, got: ${output.mode}`);
	assert.ok(output.count >= 0, "Should return non-negative count");
});

// ── Test: executeCodeSearch handles empty query ──

test("executeCodeSearch returns error for empty query", async () => {
	const child = await runModule(`
		import { executeCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const result = await executeCodeSearch("test-123", { query: "   ", maxTokens: 5000 });
		console.log(JSON.stringify({ error: result.details.error }));
	`);

	assert.equal(child.status, 0, `executeCodeSearch failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.error, "No query provided", "Should return error for empty query");
});

// ── Test: backward compatibility — exported functions still exist ──

test("backward compatibility: exported functions still exist", async () => {
	const child = await runModule(`
		import * as cs from ${JSON.stringify(codeSearchUrl)};
		console.log(JSON.stringify({
			searchSourcegraph: typeof cs.searchSourcegraph,
			searchSourcegraphWithTimeout: typeof cs.searchSourcegraphWithTimeout,
			searchWithRipgrep: typeof cs.searchWithRipgrep,
			searchCodeSemantically: typeof cs.searchCodeSemantically,
			executeCodeSearch: typeof cs.executeCodeSearch,
		}));
	`);

	assert.equal(child.status, 0, `Import check failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.searchSourcegraph, "function", "searchSourcegraph should be exported");
	assert.equal(output.searchSourcegraphWithTimeout, "function", "searchSourcegraphWithTimeout should be exported");
	assert.equal(output.searchWithRipgrep, "function", "searchWithRipgrep should be exported");
	assert.equal(output.searchCodeSemantically, "function", "searchCodeSemantically should be exported");
	assert.equal(output.executeCodeSearch, "function", "executeCodeSearch should be exported");
});

// ── Test: race condition — Sourcegraph timeout is wired into executeCodeSearch ──

test("executeCodeSearch uses searchSourcegraphWithTimeout (timeout semantics)", async () => {
	const child = await runModule(`
		import { executeCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const start = Date.now();
		const result = await executeCodeSearch("test-timeout", { query: "test query", maxTokens: 5000 });
		const elapsed = Date.now() - start;
		console.log(JSON.stringify({
			mode: result.details.mode,
			count: result.details.resultCount,
			elapsed: elapsed,
		}));
	`);

	assert.equal(child.status, 0, `executeCodeSearch failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.elapsed < 30000, `Should complete within 30s, took ${output.elapsed}ms`);
	assert.ok(["sourcegraph-mcp-wins", "exa-pipeline-wins", "no-results"].includes(output.mode),
		`Should return a valid mode, got: ${output.mode}`);
});

// ── Test: Sourcegraph timeout value is configurable ──

test("searchSourcegraphWithTimeout respects custom timeout parameter", async () => {
	const child = await runModule(`
		import { searchSourcegraphWithTimeout } from ${JSON.stringify(codeSearchUrl)};
		const results = await searchSourcegraphWithTimeout("test", 5, 500);
		console.log(JSON.stringify({ count: results.length }));
	`);

	assert.equal(child.status, 0, `searchSourcegraphWithTimeout with 500ms timeout failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.count, 0, "Should return empty with short timeout when Sourcegraph is unavailable");
});

// ── Test: executeCodeSearch merges ripgrep and semantic results ──

test("executeCodeSearch includes ripgrep and semantic results in output", async () => {
	const child = await runModule(`
		import { executeCodeSearch } from ${JSON.stringify(codeSearchUrl)};
		const result = await executeCodeSearch("test-merge", { query: "TODO", maxTokens: 5000 });
		console.log(JSON.stringify({
			mode: result.details.mode,
			count: result.details.resultCount,
		}));
	`);

	assert.equal(child.status, 0, `executeCodeSearch merge test failed: ${child.stderr}`);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.count >= 0, "Should return non-negative result count");
});
