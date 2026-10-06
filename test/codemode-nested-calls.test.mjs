import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, beforeEach, test } from "node:test";

// web_search calls a codemode script makes (tool_call with parentToolCallId) must not
// curate or fetch in the background (issue #516). Only global fetch is mocked.
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const root = await mkdtemp(join(tmpdir(), "pi-codemode-nested-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.BRAVE_API_KEY = "codemode-nested-key";
delete process.env.BRAVE_BASE_URL;
await writeFile(join(root, "web-search.json"), JSON.stringify({
	workflow: "summary-review",
	fetchRouting: { providers: ["http"] },
}));

const { default: initializeExtension } = await import("../index.ts");
const { clearResults } = await import("../storage.ts");
const tools = [];
const handlers = {};
const sentMessages = [];
initializeExtension({
	registerTool(tool) { tools.push(tool); },
	registerCommand() {},
	registerShortcut() {},
	on(name, handler) { (handlers[name] ??= []).push(handler); },
	appendEntry() {},
	sendMessage(message) { sentMessages.push(message); },
});
const searchTool = tools.find(tool => tool.name === "web_search");
const contentTool = tools.find(tool => tool.name === "get_search_content");

const pageUrl = "https://93.184.216.34/page";

beforeEach(() => {
	clearResults();
	sentMessages.length = 0;
	globalThis.fetch = async input => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://api.search.brave.com/")) {
			return Response.json({ web: { results: [{ title: "Page", url: pageUrl, description: "Page snippet" }] } });
		}
		if (url === pageUrl) return new Response("Full page body.", { headers: { "content-type": "text/plain" } });
		throw new Error("Unexpected fetch: " + url);
	};
});

after(async () => {
	clearResults();
	globalThis.fetch = originalFetch;
	process.env = originalEnv;
	await rm(root, { recursive: true, force: true });
});

// Runs web_search as Pi does for a call a codemode script made: tool_call handlers first.
async function runNested(toolCallId, params) {
	for (const handler of handlers.tool_call ?? []) {
		await handler({ type: "tool_call", toolName: "web_search", toolCallId, parentToolCallId: "script", input: params });
	}
	return searchTool.execute(toolCallId, params);
}

test("a nested web_search ignores the configured summary-review workflow", async () => {
	const nested = await runNested("script/1", { query: "alpha", provider: "brave" });
	assert.notEqual(nested.isError, true);
	assert.equal(nested.structuredContent.queries[0].results[0].url, pageUrl);

	// Without the nested marker, the same config still asks to curate; with no
	// extension context that ends in an error instead of opening a browser.
	const topLevel = await searchTool.execute("script/1", { query: "alpha", provider: "brave" });
	assert.equal(topLevel.details.error, "Missing extension context");
});

test("a nested web_search with includeContent stores page content inline", async () => {
	const result = await runNested("script/2", { query: "alpha", provider: "brave", includeContent: true });
	assert.notEqual(result.isError, true);
	const { fetchId } = result.structuredContent;
	assert.ok(fetchId);
	assert.equal(result.details.fetchId, fetchId);
	assert.equal(result.details.fetchUrls, undefined);

	const page = await contentTool.execute("read", { responseId: fetchId, urlIndex: 0 });
	assert.match(page.content[0].text, /Full page body\./);
	await delay(50);
	assert.deepEqual(sentMessages, []);
});
