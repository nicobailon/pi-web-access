import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

function runScenario(config, body) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-access-fetch-modes-"));
	if (config !== undefined) {
		writeFileSync(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	}
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			${body}
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: "", HOME: join(agentDir, "home"), USERPROFILE: join(agentDir, "home") },
	});
}

test("fetch mode config rejects a default outside the allowed modes", () => {
	const child = runScenario({ fetch: { defaultMode: "readable", allowedModes: ["raw"] } }, `
		initializeExtension({ registerTool() {}, registerCommand() {}, registerShortcut() {}, on() {} });
	`);
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /fetch\.defaultMode.*must be one of fetch\.allowedModes/);
});

test("absent config exposes all modes and defaults execution to readable", () => {
	const child = runScenario(undefined, `
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls++;
			return new Response("plain readable body", { headers: { "content-type": "text/plain" } });
		};
		const tools = [];
		initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
		const tool = tools.find(({ name }) => name === "fetch_content");
		const result = await tool.execute("default", { url: "https://93.184.216.34/page" });
		console.log(JSON.stringify({
			enum: tool.parameters.properties.mode.enum,
			description: tool.parameters.properties.mode.description,
			text: result.content[0].text,
			mode: result.details.mode,
			fetchCalls,
		}));
	`);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.deepEqual(result.enum, ["readable", "raw", "answer"]);
	assert.match(result.description, /readable \(default\)/);
	assert.deepEqual({ text: result.text, mode: result.mode, fetchCalls: result.fetchCalls }, { text: "plain readable body", mode: "readable", fetchCalls: 1 });
});

test("configured modes align schema and execution and reject disabled modes before work", () => {
	const child = runScenario({ fetch: { defaultMode: "raw", allowedModes: ["raw"] } }, `
		let fetchCalls = 0;
		let modelCalls = 0;
		let updateCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls++;
			return new Response("<html>exact raw body</html>", { status: 404, headers: { "content-type": "text/html" } });
		};
		const tools = [];
		initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
		const tool = tools.find(({ name }) => name === "fetch_content");
		const ctx = { modelRegistry: { getAvailable() { modelCalls++; return []; } } };
		const defaulted = await tool.execute("default", { url: "https://93.184.216.34/page" }, undefined, undefined, ctx);
		const callsAfterDefault = fetchCalls;
		const disabled = await tool.execute("disabled", { url: "https://93.184.216.34/page", mode: "answer", prompt: "question", auth: "missing" }, undefined, () => { updateCalls++; }, ctx);
		console.log(JSON.stringify({
			enum: tool.parameters.properties.mode.enum,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			modeDescription: tool.parameters.properties.mode.description,
			defaultText: defaulted.content[0].text,
			defaultMode: defaulted.details.mode,
			defaultStatus: defaulted.details.status,
			disabledText: disabled.content[0].text,
			fetchCalls,
			callsAfterDefault,
			modelCalls,
			updateCalls,
		}));
	`);
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.deepEqual(result.enum, ["raw"]);
	assert.match(result.description, /raw \(default\): return the exact textual body using direct HTTP only/);
	assert.doesNotMatch(result.description, /readable|answer/);
	assert.doesNotMatch(result.promptSnippet, /readable|answer/);
	assert.doesNotMatch(result.modeDescription, /readable|answer/);
	assert.match(result.defaultText, /<html>exact raw body<\/html>/);
	assert.equal(result.defaultMode, "raw");
	assert.equal(result.defaultStatus, 404);
	assert.match(result.disabledText, /Fetch mode "answer" is disabled by fetch\.allowedModes/);
	assert.equal(result.fetchCalls, result.callsAfterDefault);
	assert.equal(result.modelCalls, 0);
	assert.equal(result.updateCalls, 0);
});
