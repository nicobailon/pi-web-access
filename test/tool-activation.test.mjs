import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
// A model Pi can hand added tools without a transcript checkpoint; `model: null` means no model.
const nativeAdditions = { api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } };

function run(config = {}, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-activation-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config), "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const options = ${JSON.stringify(options)};
			const model = "model" in options ? options.model ?? undefined : ${JSON.stringify(nativeAdditions)};
			const tools = new Map();
			const handlers = new Map();
			let active = ["read", "foreign_tool"];
			const pi = {
				registerTool(tool) { tools.set(tool.name, tool); if (!options.unavailable?.includes(tool.name)) active.push(tool.name); },
				registerCommand() {}, registerShortcut() {},
				on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); return () => {}; },
				getAllTools() { return [...tools.values()].filter(tool => !options.unavailable?.includes(tool.name)); },
				getActiveTools() { return [...active]; },
				setActiveTools(names) {
					if (options.throwOnSet) throw new Error("set failed");
					active = options.dropOnReadback ? names.filter(name => name !== options.dropOnReadback) : [...names];
				},
			};
			initializeExtension(pi);
			const entries = (options.messages ?? []).map((message, index) => ({
				type: "message", id: "message-" + index, parentId: index ? "message-" + (index - 1) : null,
				timestamp: new Date(index).toISOString(), message,
			}));
			const ctx = { model, sessionManager: { getBranch: () => entries } };
			for (const event of [].concat(options.event ?? "session_start")) {
				for (const handler of handlers.get(event) ?? []) await handler(options.eventPayload ?? {}, ctx);
			}
			const before = [...active];
			let result;
			if (options.activate && tools.has("web_enable")) result = await tools.get("web_enable").execute("call", {}, new AbortController().signal, () => {}, ctx);
			if (options.secondActivation && tools.has("web_enable")) await tools.get("web_enable").execute("call2", {}, new AbortController().signal, () => {}, ctx);
			const loader = tools.get("web_enable");
			console.log(JSON.stringify({
				registered: [...tools.keys()], before, after: active, result,
				loader: loader && { description: loader.description, promptSnippet: loader.promptSnippet, parameters: loader.parameters },
				definitions: [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
			}));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, XDG_CONFIG_HOME: "", HOME: join(root, "home"), USERPROFILE: join(root, "home") },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

const defaultNames = ["web_search", "source_check", "fetch_content", "get_search_content"];

test("fresh sessions expose compact configured guidance and keep web tools registered but dormant", () => {
	const state = run();
	assert.deepEqual(state.registered, [...defaultNames, "web_enable"]);
	assert.deepEqual(state.before.filter(name => defaultNames.includes(name)), []);
	assert.ok(state.before.includes("web_enable"));
	assert.match(state.loader.description, /next model request/i);
	for (const capability of ["search", "source checking", "content fetching", "stored-result retrieval"]) {
		assert.match(state.loader.promptSnippet, new RegExp(capability, "i"));
	}
	assert.deepEqual(state.loader.parameters, { type: "object", properties: {}, additionalProperties: false });
});

test("activation enables every configured name once without removing unrelated tools", () => {
	const names = ["research_web", "verify_sources", "grab_content", "open_content"];
	const state = run({ toolNames: { webSearch: names[0], sourceCheck: names[1], fetchContent: names[2], getSearchContent: names[3] } }, { activate: true, secondActivation: true });
	assert.deepEqual(state.before, ["read", "foreign_tool", "web_enable"]);
	assert.deepEqual(state.after, ["read", "foreign_tool", "web_enable", ...names]);
	assert.equal(state.result.isError, undefined);
	assert.deepEqual(state.result.details.enabled, names);
});

test("disabled capabilities are neither registered nor advertised", () => {
	const state = run({ tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } });
	assert.deepEqual(state.registered, ["fetch_content", "web_enable"]);
	assert.match(state.loader.promptSnippet, /content fetching/i);
	assert.doesNotMatch(state.loader.promptSnippet, /source checking|stored-result retrieval|web search/i);
});

test("all-disabled configuration registers no loader", () => {
	const disabled = Object.fromEntries(["webSearch", "sourceCheck", "fetchContent", "getSearchContent"].map(key => [key, { enabled: false }]));
	const state = run({ tools: disabled });
	assert.deepEqual(state.registered, []);
	assert.deepEqual(state.before, ["read", "foreign_tool"]);
});

test("eager activation config registers no loader and keeps web tools active", () => {
	const state = run({ toolActivation: "eager" });
	assert.deepEqual(state.registered, defaultNames);
	assert.deepEqual(state.before.filter(name => defaultNames.includes(name)), defaultNames);
});

test("auto starts with web_enable only on models that take added tools without a transcript checkpoint", () => {
	const models = [
		nativeAdditions,
		{ api: "openai-completions", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } },
		{ api: "openai-responses", compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } },
		{ api: "openai-codex-responses", compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true } },
	];
	for (const model of models) {
		const state = run({ toolActivation: "auto" }, { model });
		assert.deepEqual(state.before, ["read", "foreign_tool", "web_enable"], model.api);
	}
});

test("auto keeps every web tool active from the start where web_enable would force a checkpoint", () => {
	const models = [
		null,
		{ api: "openai-completions", provider: "deepseek", compat: { supportsMidConvoSystemMessages: true } },
		{ api: "anthropic-messages", compat: { supportsMidConvoSystemMessages: true } },
		{ api: "openai-responses", compat: { supportsAdditionalTools: true } },
		{ api: "google-generative-ai", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, supportsAdditionalTools: true } },
	];
	for (const model of models) {
		const state = run({}, { model, event: ["session_start", "before_agent_start"] });
		assert.ok(state.registered.includes("web_enable"));
		assert.deepEqual(state.before, ["read", "foreign_tool", ...defaultNames], model?.api ?? "no model");
	}
});

test("explicit dynamic activation keeps web_enable on models that would checkpoint", () => {
	const state = run({ toolActivation: "dynamic" }, { model: null });
	assert.deepEqual(state.before, ["read", "foreign_tool", "web_enable"]);
});

test("auto leaves recorded and legacy sessions with the tools they already had", () => {
	const tool = name => ({ name, description: "", parameters: { type: "object" } });
	const warm = run({}, { model: null, messages: [{ role: "system", content: "", toolsAdded: [tool("web_enable"), tool("web_search")], timestamp: 1 }] });
	assert.deepEqual(warm.before, ["read", "foreign_tool", "web_search", "web_enable"]);

	const legacy = run({}, { model: null, messages: [{ role: "user", content: [{ type: "text", text: "old session" }], timestamp: 1 }] });
	assert.deepEqual(legacy.before, ["read", "foreign_tool", ...defaultNames, "web_enable"]);
});

test("excluded loader leaves permitted legacy tools active", () => {
	const state = run({}, { unavailable: ["web_enable"] });
	assert.deepEqual(state.before.filter(name => defaultNames.includes(name)), defaultNames);
	assert.equal(state.before.includes("web_enable"), false);
});

test("activation reports unavailable and failed readback without false success", () => {
	const unavailable = run({}, { activate: true, unavailable: ["source_check"] });
	assert.equal(unavailable.result.isError, true);
	assert.deepEqual(unavailable.result.details.unavailable, ["source_check"]);

	const readback = run({}, { activate: true, dropOnReadback: "fetch_content" });
	assert.equal(readback.result.isError, true);
	assert.deepEqual(readback.result.details.missing, ["fetch_content"]);
	assert.equal(readback.result.content[0].text, "Tools still inactive after activation: fetch_content.");

	const thrown = run({}, { activate: true, throwOnSet: true });
	assert.equal(thrown.result.isError, true);
	assert.match(thrown.result.details.error, /set failed/);
});

test("cold and warm native transcript selections survive start and tree lifecycle", () => {
	const coldMessages = [{ role: "system", content: "", toolsAdded: [{ name: "web_enable", description: "", parameters: { type: "object" } }], timestamp: 1 }];
	const cold = run({}, { messages: coldMessages });
	assert.deepEqual(cold.before.filter(name => defaultNames.includes(name)), []);

	const warmMessages = [{ role: "system", content: "", toolsAdded: [{ name: "web_enable", description: "", parameters: { type: "object" } }, { name: "web_search", description: "", parameters: { type: "object" } }], timestamp: 1 }];
	const warm = run({}, { messages: warmMessages, event: "session_tree" });
	assert.deepEqual(warm.before.filter(name => defaultNames.includes(name)), ["web_search"]);
	const reloaded = run({}, { messages: warmMessages, eventPayload: { type: "session_start", reason: "reload" } });
	assert.deepEqual(reloaded.before.filter(name => defaultNames.includes(name)), ["web_search"]);
});

test("legacy conversation without tool declarations preserves eager web tools", () => {
	const state = run({}, { messages: [{ role: "user", content: [{ type: "text", text: "old session" }], timestamp: 1 }] });
	assert.deepEqual(state.before.filter(name => defaultNames.includes(name)), defaultNames);
	assert.ok(state.before.includes("web_enable"));
});

test("a resumed transcript that declared its tools without web_enable keeps that set", () => {
	const tool = name => ({ name, description: "", parameters: { type: "object" } });
	const turn = { role: "user", content: [{ type: "text", text: "Run: echo hello" }], timestamp: 2 };
	const event = ["session_start", "before_agent_start"];
	const upgraded = run({}, { messages: [{ role: "system", content: "", toolsAdded: [tool("read")], timestamp: 1 }, turn], event });
	assert.equal(upgraded.before.includes("web_enable"), false);
	assert.deepEqual(upgraded.before.filter(name => defaultNames.includes(name)), []);

	const recorded = run({}, { messages: [{ role: "system", content: "", toolsAdded: [tool("read"), tool("web_enable")], timestamp: 1 }, turn], event });
	assert.ok(recorded.before.includes("web_enable"));
});

test("provider-facing cold and activated schemas stay within budget", () => {
	const cold = run();
	const coldCharacters = cold.definitions.filter(tool => cold.before.includes(tool.name))
		.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
	assert.ok(coldCharacters <= 700, `cold schema is ${coldCharacters} characters`);

	const activated = run({}, { activate: true });
	const activatedCharacters = activated.definitions.filter(tool => activated.after.includes(tool.name))
		.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
	assert.ok(activatedCharacters <= 12_119, `activated schema is ${activatedCharacters} characters`);
});
