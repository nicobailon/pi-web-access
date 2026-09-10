import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CuratorRunState, registerCuratorRunLifecycle } from "../curator-run.ts";

test("approval changes only inherited summary-review workflows for the current prompt", () => {
	const state = new CuratorRunState();
	state.approveRemainingSearches();

	assert.equal(state.resolve(undefined, undefined, true), "auto-summary");
	assert.equal(state.resolve(undefined, "summary-review", true), "auto-summary");
	assert.equal(state.resolve(undefined, "none", true), "none");
	assert.equal(state.resolve(undefined, "auto-summary", true), "auto-summary");

	for (const explicit of ["none", "auto-summary", "summary-review"]) {
		assert.equal(state.resolve(explicit, "summary-review", true), explicit);
	}
});

test("registered lifecycle preserves approval across internal turns and resets at run boundaries", async () => {
	const handlers = new Map();
	const state = registerCuratorRunLifecycle({
		on(event, handler) { handlers.set(event, handler); },
	});

	await handlers.get("before_agent_start")?.({}, {});
	state.approveRemainingSearches();

	// A multi-tool agent loop crosses these internal boundaries. They must not
	// clear a preference selected while handling the original user prompt.
	await handlers.get("turn_end")?.({}, {});
	await handlers.get("turn_start")?.({}, {});
	assert.equal(state.resolve(undefined, "summary-review", true), "auto-summary");
	assert.equal(state.resolve("summary-review", "none", true), "summary-review");

	await handlers.get("agent_settled")?.({}, {});
	assert.equal(state.resolve(undefined, "summary-review", true), "summary-review");

	state.approveRemainingSearches();
	await handlers.get("session_tree")?.({}, {});
	assert.equal(state.resolve(undefined, "summary-review", true), "summary-review");
});

test("extension reload clears auto-approval", () => {
	const state = new CuratorRunState();
	state.approveRemainingSearches();
	const reloadedExtensionState = new CuratorRunState();
	assert.equal(reloadedExtensionState.resolve(undefined, "summary-review", true), "summary-review");
});

test("run approval is in-memory and does not modify web-search.json", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-curator-run-"));
	const configPath = join(root, "web-search.json");
	const original = '{"workflow":"summary-review"}\n';
	writeFileSync(configPath, original, "utf8");

	const state = new CuratorRunState();
	state.approveRemainingSearches();
	assert.equal(state.resolve(undefined, "summary-review", true), "auto-summary");
	assert.equal(readFileSync(configPath, "utf8"), original);
});
