import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Codemode scripts receive a tool's structuredContent (issue #516). These tests
// drive the registered Pi tools with only global fetch mocked.
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const root = await mkdtemp(join(tmpdir(), "pi-codemode-structured-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.BRAVE_API_KEY = "codemode-structured-key";
delete process.env.BRAVE_BASE_URL;
await writeFile(join(root, "web-search.json"), JSON.stringify({
	workflow: "none",
	maxInlineContentChars: 1_000,
	fetchRouting: { providers: ["http"] },
}));

const { default: initializeExtension } = await import("../index.ts");
const { clearResults } = await import("../storage.ts");
const tools = [];
initializeExtension({
	registerTool(tool) { tools.push(tool); },
	registerCommand() {},
	registerShortcut() {},
	on() {},
	appendEntry() {},
});
const searchTool = tools.find(tool => tool.name === "web_search");
const fetchTool = tools.find(tool => tool.name === "fetch_content");
assert.ok(searchTool.outputSchema);
assert.ok(fetchTool.outputSchema);

const longUrl = "https://93.184.216.34/long";
const shortUrl = "https://93.184.216.34/short";
const badUrl = "https://93.184.216.34/blocked";
const longBody = "Long page line.\n".repeat(200);

beforeEach(() => {
	clearResults();
	globalThis.fetch = async input => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://api.search.brave.com/")) {
			const query = new URL(url).searchParams.get("q") ?? "";
			if (query.includes("fail")) return new Response("forced provider failure", { status: 401 });
			return Response.json({ web: { results: [{ title: "Example " + query, url: "https://example.com/" + encodeURIComponent(query), description: "Snippet for " + query }] } });
		}
		if (url === longUrl) return new Response(longBody, { headers: { "content-type": "text/plain" } });
		if (url === shortUrl) return new Response("Short page body.", { headers: { "content-type": "text/plain" } });
		if (url === badUrl) return new Response("Forbidden", { status: 403 });
		throw new Error("Unexpected fetch: " + url);
	};
});

after(async () => {
	clearResults();
	globalThis.fetch = originalFetch;
	process.env = originalEnv;
	await rm(root, { recursive: true, force: true });
});

test("web_search returns per-query results as structuredContent", async () => {
	const result = await searchTool.execute("search-ok", { queries: ["alpha", "beta"], provider: "brave", workflow: "none" });
	assert.notEqual(result.isError, true);
	const data = result.structuredContent;
	assert.equal(data.responseId, result.details.searchId);
	assert.equal(data.fetchId, null);
	assert.deepEqual(data.queries.map(q => [q.query, q.error, q.provider]), [["alpha", null, "brave"], ["beta", null, "brave"]]);
	assert.deepEqual(data.queries[0].results, [{ title: "Example alpha", url: "https://example.com/alpha", snippet: "Snippet for alpha" }]);
});

test("web_search keeps structuredContent with each query error when every query fails", async () => {
	const result = await searchTool.execute("search-failed", { queries: ["fail one", "fail two"], provider: "brave", workflow: "none" });
	assert.equal(result.isError, true);
	const data = result.structuredContent;
	assert.equal(data.responseId, result.details.searchId);
	assert.equal(data.queries.length, 2);
	for (const query of data.queries) {
		assert.match(query.error, /Brave Search API error 401/);
		assert.deepEqual(query.results, []);
	}
});

test("fetch_content returns full content per URL past the inline cap", async () => {
	const result = await fetchTool.execute("fetch-batch", { urls: [longUrl, shortUrl] });
	assert.notEqual(result.isError, true);
	const data = result.structuredContent;
	assert.equal(data.responseId, result.details.responseId);
	assert.deepEqual(data.urls.map(u => [u.url, u.error]), [[longUrl, null], [shortUrl, null]]);
	assert.ok(longBody.length > 1_000);
	assert.equal(data.urls[0].content.trim(), longBody.trim());
	assert.equal(data.urls[1].content.trim(), "Short page body.");
});

test("fetch_content keeps structuredContent with the error when a single URL fails", async () => {
	const result = await fetchTool.execute("fetch-failed", { url: badUrl });
	assert.equal(result.isError, true);
	const data = result.structuredContent;
	assert.equal(data.urls.length, 1);
	assert.equal(data.urls[0].url, badUrl);
	assert.match(data.urls[0].error, /HTTP 403/);
	assert.equal(data.urls[0].error, result.details.error);
});

test("argument errors carry no structuredContent", async () => {
	const search = await searchTool.execute("search-empty", { workflow: "none" });
	assert.equal(search.isError, true);
	assert.equal(search.structuredContent, undefined);
	const fetched = await fetchTool.execute("fetch-empty", {});
	assert.equal(fetched.isError, true);
	assert.equal(fetched.structuredContent, undefined);
});
