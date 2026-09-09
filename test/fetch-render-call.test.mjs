import assert from "node:assert/strict";
import { test } from "node:test";

import initializeExtension from "../index.ts";

function getFetchTool() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find(tool => tool.name === "fetch_content");
}

const theme = {
	bold: text => text,
	fg: (_name, text) => text,
};

test("fetch_content renderCall falls back to url when urls is empty", () => {
	const tool = getFetchTool();
	const lines = tool.renderCall({
		url: "https://example.com/docs",
		urls: [],
		frames: 1,
		prompt: "",
		model: "",
	}, theme).render(120).map(line => line.trimEnd());

	assert.deepEqual(lines, ["fetch https://example.com/docs"]);
});

test("fetch_content renderCall accepts (args, options, theme) signature", () => {
	const tool = getFetchTool();
	const renderOptions = { expanded: false, isPartial: false };
	const lines = tool.renderCall({
		url: "https://example.com/docs",
		urls: [],
		frames: 1,
		prompt: "",
		model: "",
	}, renderOptions, theme).render(120).map(line => line.trimEnd());

	assert.deepEqual(lines, ["fetch https://example.com/docs"]);
});
