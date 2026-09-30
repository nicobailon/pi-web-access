import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const realPiUrl = import.meta.resolve("@earendil-works/pi-coding-agent");

// Issue #428: with Pi installed globally, the host redirects the extension's Pi imports to its
// bundled copy, so neither a Pi `package.json` nor pi-ai subpaths resolve from the extension.
// Issue #444: the redirected module also reports a stale VERSION, like an old Pi peer installed
// beside the extension, which must not decide activation.
const hostRedirectHook = `
		import { registerHooks } from "node:module";
		const realPi = ${JSON.stringify(realPiUrl)};
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "@earendil-works/pi-coding-agent") {
					return { url: "host:pi-coding-agent", shortCircuit: true };
				}
				if (specifier.startsWith("@earendil-works/pi-ai/utils/transcript")) {
					throw Object.assign(new Error("Cannot find module '" + specifier + "'"), { code: "ERR_MODULE_NOT_FOUND" });
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url === "host:pi-coding-agent") {
					return {
						format: "module",
						shortCircuit: true,
						source: 'export * from ' + JSON.stringify(realPi) + '; export const VERSION = "0.85.1";',
					};
				}
				return nextLoad(url, context);
			},
		});
	`;

function run({ messages = [], hook = "", legacyHost = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-version-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify({ toolActivation: "dynamic" }), "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			${hook}
			const warnings = [];
			const originalWarn = console.warn;
			console.warn = (...args) => warnings.push(args.map(String).join(" "));
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const tools = new Map();
			const handlers = new Map();
			let active = ["read"];
			const pi = {
				registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
				registerCommand() {}, registerShortcut() {},
				on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); if (!${legacyHost}) return () => {}; },
				getAllTools() { return [...tools.values()]; },
				getActiveTools() { return [...active]; },
				setActiveTools(names) { active = [...names]; },
			};
			initializeExtension(pi);
			const entries = ${JSON.stringify(messages)}.map((message, index) => ({
				type: "message", id: "message-" + index, parentId: index ? "message-" + (index - 1) : null,
				timestamp: new Date(index).toISOString(), message,
			}));
			const ctx = { sessionManager: { getBranch: () => entries } };
			for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
			await new Promise(resolve => setTimeout(resolve, 0));
			console.warn = originalWarn;
			console.log(JSON.stringify({ active, warnings, registered: [...tools.keys()] }));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root,
			XDG_CONFIG_HOME: "",
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
		},
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

test("activation ignores the imported Pi version and needs no Pi package on disk", () => {
	const state = run({ hook: hostRedirectHook });
	assert.deepEqual(state.warnings, []);
	assert.ok(state.active.includes("web_enable"), `expected web_enable, got ${state.active.join(", ")}`);
	const web = ["web_search", "source_check", "fetch_content", "get_search_content"];
	assert.deepEqual(state.active.filter(name => web.includes(name)), [], `web tools should stay dormant, got ${state.active.join(", ")}`);
});

test("a host-redirected warm session restores exactly the tools it recorded", () => {
	const messages = [
		{ role: "system", content: "", toolsAdded: [{ name: "web_search", description: "", parameters: { type: "object" } }], timestamp: 1 },
		{ role: "system", content: "", toolsRemoved: [{ name: "source_check" }], timestamp: 2 },
	];
	const state = run({ messages, hook: hostRedirectHook });
	assert.deepEqual(state.warnings, []);
	assert.ok(state.active.includes("web_search"), `expected restored web_search, got ${state.active.join(", ")}`);
	assert.equal(state.active.includes("fetch_content"), false, `fetch_content was never recorded, got ${state.active.join(", ")}`);
});

test("a host older than 0.86.0 falls back to eager web tools without crashing", () => {
	const state = run({ legacyHost: true });
	assert.equal(state.warnings.length, 1);
	assert.match(state.warnings[0], /requires Pi 0\.86\.0 or newer/);
	assert.equal(state.active.includes("web_enable"), false);
	assert.ok(state.active.includes("web_search"), `expected eager web_search, got ${state.active.join(", ")}`);
});
