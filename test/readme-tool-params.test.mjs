import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";

import initializeExtension from "../index.ts";
import { MCP_TOOL_DEFINITIONS } from "../mcp-tool-definitions.ts";

// Tool schemas carry short descriptions only; each parameter's details live in the tool's README section.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function readmeSection(tool) {
	const start = readme.indexOf(`\n### ${tool}\n`);
	assert.notEqual(start, -1, `README has no "### ${tool}" section`);
	const rest = readme.slice(start + 1);
	const end = rest.search(/\n##+ /);
	return end === -1 ? rest : rest.slice(0, end);
}

function undocumented(tool, properties) {
	const section = readmeSection(tool);
	return Object.keys(properties).filter((name) => !section.includes(`\`${name}\``)).map((name) => `${tool}.${name}`);
}

test("every Pi and MCP tool parameter is named in its tool's README section", () => {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
	});
	assert.deepEqual(tools.map((tool) => tool.name), ["web_search", "source_check", "fetch_content", "get_search_content"]);
	const missing = [
		...tools.flatMap((tool) => undocumented(tool.name, tool.parameters.properties)),
		...MCP_TOOL_DEFINITIONS.flatMap((tool) => undocumented(tool.name, tool.inputSchema.properties)),
	];
	assert.deepEqual([...new Set(missing)], []);
	assert.equal(tools.find((tool) => tool.name === "web_search").parameters.properties.objective.maxLength, 4096);
	assert.equal(MCP_TOOL_DEFINITIONS.find((tool) => tool.name === "web_search").inputSchema.properties.objective.maxLength, 4096);
	for (const schema of [tools.find((tool) => tool.name === "web_search").parameters, MCP_TOOL_DEFINITIONS.find((tool) => tool.name === "web_search").inputSchema]) {
		assert.equal(Value.Check(schema, { query: "q", objective: "x".repeat(4096) }), true);
		assert.equal(Value.Check(schema, { query: "q", objective: "x".repeat(4097) }), false);
		assert.equal(Value.Check(schema, { query: "q", objective: 42 }), false);
	}
});
