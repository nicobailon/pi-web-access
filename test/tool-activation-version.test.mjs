import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const realPiUrl = import.meta.resolve("@earendil-works/pi-coding-agent");

// The deployed shape for issue #428: Pi is installed globally and the extension is
// installed as a Pi package, so `@earendil-works/pi-coding-agent` is absent from the
// extension's `node_modules`. Pi's extension loader keeps working by redirecting the
// extension's own imports to its bundled copy, but `import.meta.resolve()` skips that
// redirect. Point the specifier at a host-redirected module that has no `package.json`
// on disk, and report a Pi version an `import.meta.resolve()` based probe cannot read.
function hostRedirectHook(version) {
	return `
		import { registerHooks } from "node:module";
		const realPi = ${JSON.stringify(realPiUrl)};
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier === "@earendil-works/pi-coding-agent") {
					return { url: "host:pi-coding-agent", shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url === "host:pi-coding-agent") {
					return {
						format: "module",
						shortCircuit: true,
						source: 'export * from ' + JSON.stringify(realPi) + '; export const VERSION = ' + JSON.stringify(${JSON.stringify(version)}) + ';',
					};
				}
				return nextLoad(url, context);
			},
		});
	`;
}

// Bundled Pi builds (the single-file binary shipped by installers) provide
// `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` as virtual modules.
// Static imports and the package root resolve, but deeper subpath exports such as
// `@earendil-works/pi-ai/utils/transcript` fail with ERR_MODULE_NOT_FOUND from
// extension code, and no `node_modules` exists on disk to fall back to.
const unresolvableSubpathHook = `
	import { registerHooks } from "node:module";
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@earendil-works/pi-ai/utils/transcript" || specifier === "@earendil-works/pi-ai/utils/transcript.ts") {
				const error = new Error("Cannot find module '" + specifier + "'");
				error.code = "ERR_MODULE_NOT_FOUND";
				throw error;
			}
			return nextResolve(specifier, context);
		},
	});
`;

function run({ messages = [], hook = "" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-version-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify({}), "utf8");
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
				on(event, handler) { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
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

test("activation needs no Pi package on disk when the host redirects extension imports", () => {
	const state = run({ hook: hostRedirectHook("0.87.1") });
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
	const state = run({ messages, hook: hostRedirectHook("0.87.1") });
	assert.deepEqual(state.warnings, []);
	assert.ok(state.active.includes("web_search"), `expected restored web_search, got ${state.active.join(", ")}`);
	assert.equal(state.active.includes("fetch_content"), false, `fetch_content was never recorded, got ${state.active.join(", ")}`);
});

test("a host older than 0.86.1 falls back to eager web tools without crashing", () => {
	const state = run({ hook: hostRedirectHook("0.86.0") });
	assert.equal(state.warnings.length, 1);
	assert.match(state.warnings[0], /requires Pi 0\.86\.1 or newer/);
	assert.equal(state.active.includes("web_enable"), false);
	assert.ok(state.active.includes("web_search"), `expected eager web_search, got ${state.active.join(", ")}`);
});

test("warm session tool restoration uses the pi-ai package root, not the transcript subpath", () => {
	const messages = [{ role: "system", content: "", toolsAdded: [{ name: "web_search", description: "", parameters: { type: "object" } }], timestamp: 1 }];
	const state = run({ messages, hook: unresolvableSubpathHook });
	assert.deepEqual(state.warnings, []);
	assert.ok(state.active.includes("web_search"), `expected restored web_search, got ${state.active.join(", ")}`);
});
test("dynamic tool activation gates on the running Pi version", async () => {
	const { versionAtLeast } = await import("../tool-activation.ts");
	for (const version of ["0.86.1", "0.86.2", "0.86.10", "0.87.0", "0.87.0-beta.1", "1.0.0", "2.1.3"]) {
		assert.equal(versionAtLeast(version, [0, 86, 1]), true, `${version} should support dynamic tools`);
	}
	for (const version of ["0.79.1", "0.85.9", "0.86.0", "", "garbage", "0.86", "1.x.0"]) {
		assert.equal(versionAtLeast(version, [0, 86, 1]), false, `${version} should not support dynamic tools`);
	}
});
