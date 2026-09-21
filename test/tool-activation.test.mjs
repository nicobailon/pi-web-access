import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

function run(config = {}, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-activation-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config), "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const options = ${JSON.stringify(options)};
			const tools = new Map();
			const handlers = new Map();
			let active = ["read", "foreign_tool"];
			const pi = {
				registerTool(tool) { tools.set(tool.name, tool); if (!options.unavailable?.includes(tool.name)) active.push(tool.name); },
				registerCommand() {}, registerShortcut() {},
				on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
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
			const ctx = { sessionManager: { getBranch: () => entries } };
			for (const handler of handlers.get(options.event ?? "session_start") ?? []) await handler(options.eventPayload ?? {}, ctx);
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

test("provider-facing cold and activated schemas stay within budget", () => {
	const cold = run();
	const coldCharacters = cold.definitions.filter(tool => cold.before.includes(tool.name))
		.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
	assert.ok(coldCharacters <= 700, `cold schema is ${coldCharacters} characters`);

	const activated = run({}, { activate: true });
	const activatedCharacters = activated.definitions.filter(tool => activated.after.includes(tool.name))
		.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
	assert.ok(activatedCharacters <= 11_924, `activated schema is ${activatedCharacters} characters`);
});
