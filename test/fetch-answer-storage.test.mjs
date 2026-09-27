import assert from "node:assert/strict";
import { after, test } from "node:test";

import initializeExtension from "../index.ts";
import { clearResults, getResult } from "../storage.ts";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

test("answer mode stores original fetched content instead of its answer presentation", async () => {
	clearResults();
	const originalContent = "Original page content. ".repeat(60);
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>Stored Page</title></head><body><article><h1>Stored Page</h1><p>${originalContent}</p></article></body></html>`,
		{ status: 200, headers: { "content-type": "text/html" } },
	);
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	const tool = tools.find(registered => registered.name === "fetch_content");
	assert.ok(tool);

	const result = await tool.execute(
		"call",
		{ url: "https://93.184.216.34/page", mode: "answer", prompt: "What does it say?" },
		undefined,
		undefined,
		{ model: undefined, modelRegistry: {}, scopedModels: [] },
	);
	assert.match(result.details.error, /Page answer failed/);
	const stored = getResult(result.details.responseId);
	assert.equal(stored?.type, "fetch");
	assert.match(stored?.urls?.[0].content ?? "", /Original page content/);
	assert.doesNotMatch(stored?.urls?.[0].content ?? "", /Page answer failed/);
});
