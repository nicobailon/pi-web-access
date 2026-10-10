import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseStringifiedArrays } from "../tool-arguments.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;

test("JSON-string arrays become arrays; other values are untouched", () => {
	const args = { provider: '["parallel-mcp"]', queries: '["a", "b"]', domainFilter: "example.com", numResults: 8 };
	assert.deepEqual(parseStringifiedArrays(args, ["provider", "queries", "domainFilter"]), {
		provider: ["parallel-mcp"], queries: ["a", "b"], domainFilter: "example.com", numResults: 8,
	});
	assert.equal(parseStringifiedArrays({ provider: "exa" }, ["provider"]).provider, "exa");
	assert.throws(() => parseStringifiedArrays({ provider: "[not json" }, ["provider"]), /provider must be an array of strings; the given value is not valid JSON/);
	assert.equal(parseStringifiedArrays({ provider: "[1, 2]" }, ["provider"]).provider, "[1, 2]");
	const unchanged = { query: "x" };
	assert.equal(parseStringifiedArrays(unchanged, ["provider"]), unchanged);
});

test("web_search repairs a stringified provider array before validation", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-args-"));
	const result = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const tools = [];
			(await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
			const search = tools.find((t) => t.name === "web_search");
			console.log(JSON.stringify(search.prepareArguments({ provider: '["parallel-mcp"]', queries: ["q"] })));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home") },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").pop()), { provider: ["parallel-mcp"], queries: ["q"] });
});
