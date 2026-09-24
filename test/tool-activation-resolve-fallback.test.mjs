import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Pi's bundled loader satisfies the static import via virtualModules, but
// import.meta.resolve() still uses disk resolution and throws.
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const source = readFileSync(fileURLToPath(new URL("../tool-activation.ts", import.meta.url)), "utf8");
const virtualModules = {
	"@earendil-works/pi-coding-agent": { buildSessionContext() { return {}; } },
	typebox: { Type: { Object: (schema) => schema } },
};

function fixture(version) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-resolve-"));
	if (version) {
		const pkg = join(root, "node_modules/@earendil-works/pi-coding-agent");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version,
			type: "module",
			exports: { ".": "./dist/index.js" },
		}));
		writeFileSync(join(pkg, "dist/index.js"), "export function buildSessionContext() { return {}; }\n");
	}
	writeFileSync(join(root, "tool-activation.ts"), source);
	writeFileSync(join(root, "probe.ts"), `
		export function probe() {
			try {
				return { threw: false, resolved: import.meta.resolve("@earendil-works/pi-coding-agent") };
			} catch (error) {
				return { threw: true, message: error instanceof Error ? error.message : String(error) };
			}
		}
	`);
	return root;
}

async function activate(root) {
	const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false, virtualModules });
	const loaded = await jiti.import(join(root, "probe.ts"));
	const mod = await jiti.import(join(root, "tool-activation.ts"));
	const warnings = [];
	const tools = [];
	const pi = {
		registerTool(tool) { tools.push(tool); },
		on() {},
		getAllTools() { return tools; },
		getActiveTools() { return []; },
		setActiveTools() {},
	};
	const warn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		mod.registerWebToolActivation(pi, [{ name: "web_search", capability: "search" }]);
	} finally {
		console.warn = warn;
	}
	return { probe: loaded.probe(), tools, warnings };
}

test("unresolvable virtual module enables dynamic tools; a resolvable package still uses the version gate", async () => {
	const missing = fixture();
	const old = fixture("0.86.0");
	const supported = fixture("0.86.1");
	try {
		const unresolved = await activate(missing);
		assert.equal(unresolved.probe.threw, true);
		assert.match(unresolved.probe.message, /Cannot find module '@earendil-works\/pi-coding-agent'/);
		assert.deepEqual(unresolved.warnings, []);
		assert.deepEqual(unresolved.tools.map((tool) => tool.name), ["web_enable"]);

		const rejected = await activate(old);
		assert.equal(rejected.probe.threw, false);
		assert.deepEqual(rejected.tools, []);
		assert.match(rejected.warnings.join("\n"), /Dynamic tool activation requires Pi 0.86.1/);

		const accepted = await activate(supported);
		assert.equal(accepted.probe.threw, false);
		assert.deepEqual(accepted.warnings, []);
		assert.deepEqual(accepted.tools.map((tool) => tool.name), ["web_enable"]);
	} finally {
		for (const root of [missing, old, supported]) rmSync(root, { recursive: true, force: true });
	}
});
