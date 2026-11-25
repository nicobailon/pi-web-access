import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const POLICY = /Fetch mode "(answer|extract)" is blocked by the retrieval-only policy \(PI_WEB_ACCESS_RETRIEVAL_ONLY=1\)/;
const PAGE = "https://93.184.216.34/page";

function run(config, body) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-access-retrieval-only-fetch-"));
	writeFileSync(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			let fetchCalls = 0;
			let modelCalls = 0;
			globalThis.fetch = async () => {
				fetchCalls++;
				return new Response("plain readable body", { headers: { "content-type": "text/plain" } });
			};
			const modelRegistry = new Proxy({}, { get() { modelCalls++; return () => []; } });
			${body}
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: "", HOME: join(agentDir, "home"), USERPROFILE: join(agentDir, "home"), PI_WEB_ACCESS_RETRIEVAL_ONLY: "1" },
	});
}

function output(child) {
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

const allModes = { fetch: { defaultMode: "answer", allowedModes: ["readable", "raw", "answer", "extract"] } };

test("Pi fetch_content offers only readable and raw, refuses model modes, and defaults answer to readable", () => {
	const out = output(run(allModes, `
		const tools = [];
		(await import(${JSON.stringify(indexUrl)})).default({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
		const tool = tools.find(({ name }) => name === "fetch_content");
		const ctx = { modelRegistry };
		const answer = await tool.execute("a", { url: ${JSON.stringify(PAGE)}, mode: "answer", prompt: "q" }, undefined, undefined, ctx);
		const extract = await tool.execute("e", { url: ${JSON.stringify(PAGE)}, mode: "extract", fields: { price: "number" } }, undefined, undefined, ctx);
		const refusedFetchCalls = fetchCalls;
		const defaulted = await tool.execute("d", { url: ${JSON.stringify(PAGE)} }, undefined, undefined, ctx);
		const raw = await tool.execute("r", { url: ${JSON.stringify(PAGE)}, mode: "raw" }, undefined, undefined, ctx);
		const properties = tool.parameters.properties;
		console.log(JSON.stringify({
			enum: properties.mode.enum,
			modelParams: ["answerModel", "fields", "prompt"].filter(key => Object.hasOwn(properties, key)),
			advertised: JSON.stringify([tool.promptSnippet, properties.mode.description]),
			answer: answer.content[0].text,
			extract: extract.content[0].text,
			refusedFetchCalls,
			defaulted: [defaulted.details.mode, defaulted.content[0].text],
			raw: raw.content[0].text,
			modelCalls,
		}));
	`));
	assert.deepEqual(out.enum, ["readable", "raw"]);
	assert.deepEqual(out.modelParams, []);
	assert.doesNotMatch(out.advertised, /answer|extract/);
	assert.match(out.answer, POLICY);
	assert.match(out.extract, POLICY);
	assert.equal(out.refusedFetchCalls, 0);
	assert.deepEqual(out.defaulted, ["readable", "plain readable body"]);
	assert.match(out.raw, /plain readable body/);
	assert.equal(out.modelCalls, 0);
});

test("allowedModes with only model modes fails at load with the policy error", () => {
	const child = run({ fetch: { allowedModes: ["answer"] } }, `
		(await import(${JSON.stringify(indexUrl)})).default({ registerTool() {}, registerCommand() {}, registerShortcut() {}, on() {} });
	`);
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /No retrieval route is available under the retrieval-only policy .*fetch mode routes that use a model were skipped: answer\./);
});

test("MCP refuses model modes with the policy error and still fetches readable pages", () => {
	const out = output(run(allModes, `
		const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreUrl)});
		const core = createStandaloneWebToolCore();
		const answer = await core.fetchContent({ url: ${JSON.stringify(PAGE)}, mode: "answer", prompt: "q" });
		const extract = await core.fetchContent({ url: ${JSON.stringify(PAGE)}, mode: "extract", fields: { price: "number" } });
		const refusedFetchCalls = fetchCalls;
		const readable = await core.fetchContent({ url: ${JSON.stringify(PAGE)} });
		console.log(JSON.stringify({ answer: answer.content[0].text, extract: extract.content[0].text, refusedFetchCalls, readable: [readable.isError === true, readable.content[0].text] }));
	`));
	assert.match(out.answer, POLICY);
	assert.match(out.extract, POLICY);
	assert.equal(out.refusedFetchCalls, 0);
	assert.equal(out.readable[0], false);
	assert.match(out.readable[1], /plain readable body/);
});
