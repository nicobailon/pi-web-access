import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

// Model calls answer successfully, so a summary or rewrite that slips through shows up in the output.
function run(config, body, env = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-retrieval-only-workflows-"));
	writeFileSync(join(home, "web-search.json"), JSON.stringify({ autoOpenBrowser: false, curatorTimeoutSeconds: 5, ...config }) + "\n");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const nativeFetch = globalThis.fetch;
			const searchRequests = [];
			const modelCalls = [];
			globalThis.fetch = async (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.startsWith("http://127.0.0.1")) return nativeFetch(input, init);
				searchRequests.push(url);
				return Response.json({ web: { results: [{ title: "Brave hit", url: "https://example.com/hit", description: "plain result" }] } });
			};
			const model = { provider: "anthropic", id: "claude-haiku-4-5", api: "test", input: ["text"] };
			const reply = { stopReason: "stop", content: [{ type: "text", text: "model wrote this" }] };
			const modelRegistry = {
				getAll: () => [model],
				getAvailable: () => [model],
				find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
				async complete() { modelCalls.push("complete"); return reply; },
				streamSimple() { modelCalls.push("streamSimple"); return { result: async () => reply }; },
			};
			const tools = [];
			const commands = new Map();
			const notifications = [];
			(await import(${JSON.stringify(indexUrl)})).default({
				registerTool(tool) { tools.push(tool); },
				registerCommand(name, command) { commands.set(name, command); },
				registerShortcut() {}, on() {}, appendEntry() {}, sendMessage() {},
			});
			const ctx = { model, modelRegistry, scopedModels: [], cwd: process.cwd(), hasUI: true, isProjectTrusted() { return true; }, ui: { notify(message) { notifications.push(message); } } };
			const webSearch = tools.find(tool => tool.name === "web_search");
			${body}
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home"), BRAVE_API_KEY: "b", PI_WEB_ACCESS_RETRIEVAL_ONLY: "1", ...env },
		timeout: 30_000,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("summary workflows requested on the call are refused before any search or model call", () => {
	const out = run({}, `
		const review = await webSearch.execute("r", { query: "q", provider: "brave", workflow: "summary-review" }, undefined, undefined, ctx);
		const auto = await webSearch.execute("a", { query: "q", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
		const noUi = await webSearch.execute("n", { query: "q", provider: "brave", workflow: "summary-review" }, undefined, undefined, { ...ctx, hasUI: false });
		console.log(JSON.stringify({ review: review.content[0].text, auto: auto.content[0].text, noUi: noUi.content[0].text, searchRequests, modelCalls }));
	`);
	assert.match(out.review, /Workflow "summary-review" is blocked by the retrieval-only policy/);
	assert.match(out.auto, /Workflow "auto-summary" is blocked by the retrieval-only policy/);
	assert.match(out.noUi, /Workflow "summary-review" is blocked by the retrieval-only policy/);
	assert.deepEqual(out.searchRequests, []);
	assert.deepEqual(out.modelCalls, []);
});

test("the policy read at load holds for the whole process, for every route", () => {
	// Edits web-search.json after the extension loaded, then asks for a model search provider and a summary.
	const afterEdit = (retrievalOnly) => `
		const { writeFileSync } = await import("node:fs");
		writeFileSync(process.env.PI_CODING_AGENT_DIR + "/web-search.json", JSON.stringify({ retrievalOnly: ${retrievalOnly} }));
		// Pi turns a thrown error into a tool error, so both outcomes are read as text.
		const text = (params) => webSearch.execute("c", params, undefined, undefined, ctx).then(result => result.content[0].text, err => err.message);
		const gemini = await text({ query: "q", provider: "gemini" });
		const auto = await text({ query: "q", provider: "brave", workflow: "auto-summary" });
		console.log(JSON.stringify({ gemini, auto, modelCalls }));
	`;
	const loadedOn = run({ retrievalOnly: true }, afterEdit(false), { PI_WEB_ACCESS_RETRIEVAL_ONLY: "" });
	assert.match(loadedOn.gemini, /Search provider "gemini" is blocked by the retrieval-only policy \(retrievalOnly: true in /);
	assert.match(loadedOn.auto, /Workflow "auto-summary" is blocked by the retrieval-only policy/);
	assert.deepEqual(loadedOn.modelCalls, []);

	// Gemini has no credentials here, so it fails for that reason rather than for the policy.
	const loadedOff = run({}, afterEdit(true), { PI_WEB_ACCESS_RETRIEVAL_ONLY: "" });
	assert.doesNotMatch(loadedOff.gemini, /retrieval-only policy/);
	assert.doesNotMatch(loadedOff.auto, /retrieval-only policy/);
	assert.ok(loadedOff.modelCalls.length > 0, "the summary the loaded policy allows should run");
});

test("a saved auto-summary default is dropped: plain results, no model call", () => {
	const out = run({ workflow: "auto-summary" }, `
		const result = await webSearch.execute("d", { query: "q", provider: "brave" }, undefined, undefined, ctx);
		console.log(JSON.stringify({ text: result.content[0].text, isError: result.isError === true, modelCalls }));
	`);
	assert.equal(out.isError, false);
	assert.match(out.text, /Brave hit/);
	assert.doesNotMatch(out.text, /model wrote this/);
	assert.deepEqual(out.modelCalls, []);
});

test("the /websearch Curator still searches but offers no summary models and refuses summary and rewrite", () => {
	const out = run({}, `
		await commands.get("websearch").handler("q", ctx);
		const curatorUrl = new URL(notifications.map(note => note.match(/http:\\/\\/[^ ]+/)?.[0]).find(Boolean));
		const token = curatorUrl.searchParams.get("session");
		const post = async (path, body) => {
			const response = await nativeFetch(new URL(path, curatorUrl.origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) });
			return { status: response.status, ...(await response.json()) };
		};
		const html = await (await nativeFetch(curatorUrl)).text();
		const stateUrl = new URL("/state", curatorUrl.origin);
		stateUrl.searchParams.set("session", token);
		for (let attempt = 0; attempt < 100 && !(await (await nativeFetch(stateUrl)).json()).done; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		const summarize = await post("/summarize", { selected: [0] });
		const rewrite = await post("/rewrite", { query: "q" });
		await post("/cancel", {});
		console.log(JSON.stringify({
			noSummaryModels: html.includes('"summaryModels":[]'),
			summarize: [summarize.status, summarize.error],
			rewrite: [rewrite.status, rewrite.error],
			searched: searchRequests.length > 0,
			modelCalls,
		}));
	`);
	assert.equal(out.noSummaryModels, true);
	assert.equal(out.summarize[0], 500);
	assert.match(out.summarize[1], /^Summary generation is blocked by the retrieval-only policy \(PI_WEB_ACCESS_RETRIEVAL_ONLY=1\)/);
	assert.equal(out.rewrite[0], 500);
	assert.match(out.rewrite[1], /Query rewrite is blocked by the retrieval-only policy/);
	assert.equal(out.searched, true);
	assert.deepEqual(out.modelCalls, []);
});
