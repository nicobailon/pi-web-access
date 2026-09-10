import assert from "node:assert/strict";
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

	assert.equal(state.resolve(undefined, "summary-review", true), "auto-summary");
	assert.equal(state.resolve("summary-review", "none", true), "summary-review");

	await handlers.get("agent_settled")?.({}, {});
	assert.equal(state.resolve(undefined, "summary-review", true), "summary-review");

	state.approveRemainingSearches();
	await handlers.get("session_tree")?.({}, {});
	assert.equal(state.resolve(undefined, "summary-review", true), "summary-review");
});
