import assert from "node:assert/strict";
import { test } from "node:test";

import initializeExtension from "../index.ts";

function getTool(name) {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find(tool => tool.name === name);
}

const theme = {
	bold: text => text,
	fg: (_name, text) => text,
};

test("fetch_content renderCall falls back to url when urls is empty", () => {
	const tool = getTool("fetch_content");
	const lines = tool.renderCall({
		url: "https://example.com/docs",
		urls: [],
		frames: 1,
		prompt: "",
		model: "",
	}, theme).render(120).map(line => line.trimEnd());

	assert.deepEqual(lines, ["fetch https://example.com/docs"]);
});

test("fetch_content renderCall tolerates invalid normalized parameters", () => {
	const tool = getTool("fetch_content");
	for (const args of [{ auth: 1 }, { mode: "invalid" }, { proxy: null }]) {
		const lines = tool.renderCall(args, theme).render(120).map(line => line.trimEnd());
		assert.deepEqual(lines, ["fetch (invalid parameters)"]);
	}
});

test("search queries and fetch URLs remain complete in wide tool-call labels", () => {
	const query = "Google Cloud API key best practices restrict HTTP referrers and APIs";
	const url = "https://developers.google.com/maps/api-security-best-practices";
	assert.deepEqual(getTool("web_search").renderCall({ query }, theme).render(200).map(line => line.trimEnd()), [`search "${query}"`]);
	assert.deepEqual(getTool("fetch_content").renderCall({ url }, theme).render(200).map(line => line.trimEnd()), [`fetch ${url}`]);
	assert.deepEqual(getTool("web_search").renderCall({ queries: [query, query] }, theme).render(200).map(line => line.trimEnd()), [
		"search 2 queries", `  "${query}"`, `  "${query}"`,
	]);
	assert.deepEqual(getTool("fetch_content").renderCall({ urls: [url, `${url}?ref=docs`] }, theme).render(200).map(line => line.trimEnd()), [
		"fetch 2 URLs", `  ${url}`, `  ${url}?ref=docs`,
	]);
});
