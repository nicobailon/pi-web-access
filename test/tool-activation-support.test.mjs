import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { registerWebToolActivation } from "../tool-activation.ts";

// Unit tests for supportsDynamicTools via registerWebToolActivation.
// The existing integration tests import index.ts in a child process where the
// devDependency copy of pi-coding-agent makes import.meta.resolve succeed;
// under Pi's hosted jiti loader the peer dependency is only reachable through
// jiti aliases, which is where the false-negative version check surfaced.

const TOOLS = [
	{ name: "web_search", capability: "search" },
	{ name: "fetch_content", capability: "fetch" },
];

function createMockPi({ dynamic }) {
	const registered = [];
	const warnings = [];
	const pi = {
		registerTool: (tool) => registered.push(tool),
		on: () => () => {},
		getAllTools: () => [...TOOLS.map(t => ({ name: t.name }))],
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	if (!dynamic) {
		delete pi.getAllTools;
		delete pi.getActiveTools;
		delete pi.setActiveTools;
	}
	const warn = mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
	return { pi, registered, warnings, restore: () => warn.mock.restore() };
}

test("registers web_enable loader when dynamic tool APIs are present", () => {
	const { pi, registered, warnings, restore } = createMockPi({ dynamic: true });
	try {
		registerWebToolActivation(pi, TOOLS);
		assert.equal(registered.length, 1);
		assert.equal(registered[0].name, "web_enable");
		assert.equal(warnings.length, 0);
	} finally {
		restore();
	}
});

test("falls back to eager tools without web_enable when dynamic tool APIs are missing", () => {
	const { pi, registered, warnings, restore } = createMockPi({ dynamic: false });
	try {
		registerWebToolActivation(pi, TOOLS);
		assert.equal(registered.length, 0);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /requires Pi 0\.86\.1 or newer/);
	} finally {
		restore();
	}
});

test("registers nothing when no activation tools are configured", () => {
	const { pi, registered, warnings, restore } = createMockPi({ dynamic: true });
	try {
		registerWebToolActivation(pi, []);
		assert.equal(registered.length, 0);
		assert.equal(warnings.length, 0);
	} finally {
		restore();
	}
});
