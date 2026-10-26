import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const CREDENTIALS = ["BRAVE_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY"];

function registrations(extraEnv = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-tool-size-"));
	const env = { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home") };
	for (const key of CREDENTIALS) delete env[key];
	const result = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const register = () => {
				const tools = [];
				initializeExtension({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() { return () => {}; } });
				return tools.filter(t => t.name !== "web_enable").map(t => ({ definition: { name: t.name, description: t.description, parameters: t.parameters }, promptSnippet: t.promptSnippet }));
			};
			console.log(JSON.stringify([register(), register()]));
		`,
		encoding: "utf8",
		env: { ...env, ...extraEnv },
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("the default tool definitions stay within the per-request size budget", (t) => {
	const [tools] = registrations();
	assert.deepEqual(tools.map(tool => tool.definition.name), ["web_search", "source_check", "fetch_content", "get_search_content"]);
	let total = 0;
	for (const { definition, promptSnippet } of tools) {
		const chars = JSON.stringify(definition).length;
		total += chars;
		t.diagnostic(`${definition.name}: ${chars} chars (~${Math.round(chars / 4)} tokens), promptSnippet ${promptSnippet.length} chars`);
	}
	t.diagnostic(`total: ${total} chars (~${Math.round(total / 4)} tokens)`);
	assert.ok(total <= 4400, `tool definitions total ${total} chars, budget 4400`);
	for (const { definition } of tools.slice(0, 2)) {
		assert.ok(JSON.stringify(definition.parameters.properties.provider).length <= 200, `${definition.name} provider schema is too large`);
	}
	const unions = tools.flatMap(({ definition }) => Object.entries(definition.parameters.properties)
		.filter(([, schema]) => schema.anyOf)
		.map(([key]) => `${definition.name}.${key}`));
	assert.deepEqual(unions, ["fetch_content.auth", "get_search_content.findText"]);
});

test("tool definitions are byte-stable across registrations and provider credentials", () => {
	const [first, second] = registrations().map(tools => JSON.stringify(tools.map(tool => tool.definition)));
	assert.equal(second, first);
	const [withKeys] = registrations(Object.fromEntries(CREDENTIALS.map(key => [key, "test-key"])));
	assert.equal(JSON.stringify(withKeys.map(tool => tool.definition)), first);
});
