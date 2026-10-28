import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

function child(config, script, extraEnv = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-provider-arg-"));
	if (config !== undefined) writeFileSync(join(home, "web-search.json"), JSON.stringify(config) + "\n");
	const env = { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home"), ...extraEnv };
	const result = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("provider tool arguments accept names, lists, and JSON arrays, and reject anything else", () => {
	const cases = [
		"brave", " Brave ", "auto", "all", "brave,exa", " brave , EXA ", '["brave","exa"]', ["brave", "exa"], "", "  ",
		"bogus", "brave,all", "brave,brave", "[bad", 42, '["Bogus"]', '["auto"]',
	];
	const output = child(undefined, `
		const { parseProviderArgument } = await import(${JSON.stringify(new URL("../gemini-search.ts", import.meta.url).href)});
		console.log(JSON.stringify(${JSON.stringify(cases)}.map((value) => {
			try { return { value: parseProviderArgument(value) ?? null }; } catch (err) { return { error: err.message }; }
		})));
	`);
	assert.deepEqual(output.slice(0, 10), [
		{ value: "brave" }, { value: "brave" }, { value: "auto" }, { value: "all" },
		{ value: ["brave", "exa"] }, { value: ["brave", "exa"] }, { value: ["brave", "exa"] }, { value: ["brave", "exa"] },
		{ value: null }, { value: null },
	]);
	assert.match(output[10].error, /^Unknown search provider "bogus"\. Use auto, all, or one or more comma-separated names: openai, brave, .*kagi.*, linkup, ninerouter, cloudflare, searchapi, tabstack$/);
	const combined = { error: '"auto" and "all" cannot be combined with provider names' };
	assert.deepEqual(output[11], combined);
	assert.deepEqual(output[12], { error: "provider must not contain duplicates: brave" });
	assert.deepEqual(output[13], { error: "provider must be a provider name or comma-separated names; the given value is not valid JSON" });
	assert.deepEqual(output[14], { error: output[10].error.replace('"bogus"', '"42"') });
	assert.deepEqual(output[15], output[10]);
	assert.deepEqual(output[16], combined);
});

test("unknown providers fail before any request and list only allowed providers", () => {
	const run = (config) => child(config, `
		let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
		const tools = [];
		(await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
		let error; try { await tools.find(t => t.name === "web_search").execute("call", { query: "q", provider: "bogus", workflow: "none" }); } catch (err) { error = err.message; }
		const check = await tools.find(t => t.name === "source_check").execute("call", { claim: "c", provider: "bogus" }, undefined, undefined, { modelRegistry: {} });
		console.log(JSON.stringify({ calls, error, check: JSON.stringify(check.details) }));
	`, { BRAVE_API_KEY: "b" });
	const open = run(undefined);
	assert.equal(open.calls, 0);
	assert.match(open.error, /^Unknown search provider "bogus"\. .*: openai, brave, .*kagi/);
	assert.match(open.check, /Unknown search provider \\"bogus\\"/);
	const kagiOnly = run({ webSearch: { allowedProviders: ["kagi"] } });
	assert.equal(kagiOnly.calls, 0);
	assert.equal(kagiOnly.error, 'Unknown search provider "bogus". Use auto, all, or one or more comma-separated names: kagi');
});
