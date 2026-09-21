import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

// web_search and get_search_content are exercised through the real tool
// objects in a child process with an isolated config dir and a mocked fetch.
function runWebSearchThenRetrieve(config) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-access-response-id-"));
	try {
		writeFileSync(join(dir, "web-search.json"), JSON.stringify(config));
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
			globalThis.fetch = async (url) => {
				if (String(url) !== "https://api.openai.com/v1/responses") throw new Error("Unexpected fetch: " + url);
				return new Response(JSON.stringify({ output: [
					{ type: "web_search_call", action: { sources: [{ title: "Source", url: "https://example.com/source" }] } },
					{ type: "message", content: [{ type: "output_text", text: "Search answer" }] },
				] }), { status: 200, headers: { "content-type": "application/json" } });
			};
			const tools = [];
			const handlers = new Map();
			const pi = {
				registerTool(tool) { tools.push(tool); },
				registerCommand() {}, registerShortcut() {},
				on(event, handler) { handlers.set(event, handler); },
				appendEntry() {}, sendMessage() {},
			};
			const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
			initializeExtension(pi);
			await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
			const search = tools.find((t) => t.name === "web_search");
			const result = await search.execute("t", { query: "response id", provider: "openai", workflow: "none" });
			const text = result.content[0].text;
			const retrieve = tools.find((t) => t.name === "get_search_content");
			let retrieved = null;
			if (retrieve) {
				const id = text.match(/responseId "([^"]+)"/)[1];
				const r = await retrieve.execute("t2", { responseId: id, queryIndex: 0 });
				retrieved = { isError: r.isError ?? false, text: r.content[0].text };
			}
			console.log(JSON.stringify({ text, details: result.details, searchId: result.details.searchId, retrieved, hasRetrieveTool: Boolean(retrieve) }));
			`,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "response-id-test-key" },
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("web_search output tells the model the responseId that get_search_content accepts", () => {
	// Parse the id out of the human-readable output, exactly as a model would.
	const out = runWebSearchThenRetrieve({ provider: "openai" });
	assert.ok(out.hasRetrieveTool);
	assert.match(out.text, /Full search results are stored as responseId "[a-z0-9]+"\. Use get_search_content\(\{ responseId: "[a-z0-9]+", queryIndex: 0, offset: 0, limit: 30000 \}\)/);
	assert.match(out.text, /Provider:\*\* openai/);
	assert.deepEqual(out.details.queryProviders, [{ query: "response id", providers: ["openai"] }]);
	assert.equal(out.details.truncated, false);
	assert.equal(out.details.omittedChars, 0);
	assert.equal(out.text.match(/responseId "([^"]+)"/)[1], out.searchId, "printed id must be the stored searchId");
	assert.equal(out.retrieved.isError, false, out.retrieved.text);
	assert.match(out.retrieved.text, /Search answer|example\.com\/source/);
});

test("web_search output honours a renamed get_search_content tool", () => {
	const out = runWebSearchThenRetrieve({ provider: "openai", toolNames: { getSearchContent: "grab_content" } });
	assert.match(out.text, /Use grab_content\(\{ responseId: "/);
	assert.doesNotMatch(out.text, /get_search_content\(/);
});

test("web_search output omits the retrieval hint when get_search_content is disabled", () => {
	const out = runWebSearchThenRetrieve({ provider: "openai", tools: { getSearchContent: { enabled: false } } });
	assert.equal(out.hasRetrieveTool, false);
	assert.doesNotMatch(out.text, /responseId/);
	assert.ok(out.searchId, "results are still stored in details");
});
