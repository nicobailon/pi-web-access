import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { isDynamicToolsVersion } from "../tool-activation.ts";

test("version gate accepts Pi 0.86.1 and newer", () => {
	for (const version of ["0.86.1", "0.86.2", "0.87.0", "0.87.1", "1.0.0", "0.90.0-beta.1"]) {
		assert.equal(isDynamicToolsVersion(version), true, version);
	}
	for (const version of ["0.86.0", "0.85.9", "0.0.0", "", "unknown", undefined, null, 86]) {
		assert.equal(isDynamicToolsVersion(version), false, String(version));
	}
});

// Pi hands @earendil-works/pi-coding-agent to extensions as a jiti virtual
// module, so it cannot be resolved to a package.json on disk from the
// extension install directory. Simulate that by mapping the specifier to a
// data: URL module and verify activation still uses the host's VERSION.
test("dynamic activation uses the host VERSION when the package cannot be resolved on disk", () => {
	const realAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const stubSource = `export * from ${JSON.stringify(realAgentUrl)}; export const VERSION = "0.87.1";`;
	const stubUrl = `data:text/javascript,${encodeURIComponent(stubSource)}`;
	const hookSource = `
		export async function resolve(specifier, context, next) {
			if (specifier === "@earendil-works/pi-coding-agent") return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
			return next(specifier, context);
		}
	`;
	const hookUrl = `data:text/javascript,${encodeURIComponent(hookSource)}`;
	const activationUrl = new URL("../tool-activation.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import { register } from "node:module";
			register(${JSON.stringify(hookUrl)});
			const warnings = [];
			console.warn = (message) => warnings.push(String(message));
			const { registerWebToolActivation } = await import(${JSON.stringify(activationUrl)});
			const tools = [];
			const pi = {
				registerTool(tool) { tools.push(tool.name); },
				on() {},
				getAllTools() { return []; },
				getActiveTools() { return []; },
				setActiveTools() {},
			};
			registerWebToolActivation(pi, [{ name: "web_search", capability: "search" }]);
			console.log(JSON.stringify({ tools, warnings }));
		`,
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	const state = JSON.parse(child.stdout.trim().split("\n").at(-1));
	assert.deepEqual(state.warnings, []);
	assert.deepEqual(state.tools, ["web_enable"]);
});
