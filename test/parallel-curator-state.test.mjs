import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("web_search curator state is keyed per tool call for parallel calls", () => {
	assert.match(indexSrc, /const pendingCurates = new Map<string, PendingCurate>\(\)/);
	assert.match(indexSrc, /const activeCurators = new Map<string, CuratorServerHandle>\(\)/);
	assert.match(indexSrc, /const glimpseWins = new Map<string, GlimpseWindow>\(\)/);
	assert.match(indexSrc, /async execute\(callId, params, signal, onUpdate, ctx\)/);
	assert.match(indexSrc, /pendingCurates\.set\(callId, pc\)/);
	assert.match(indexSrc, /activeCurators\.get\(callId\)\?\.getConnectionState\(\)/);
	assert.doesNotMatch(indexSrc, /let pendingCurate: PendingCurate \| null/);
	assert.doesNotMatch(indexSrc, /let activeCurator: CuratorServerHandle \| null/);
});

test("manual websearch curator command uses a distinct map key", () => {
	assert.match(indexSrc, /const commandCallId = `cmd:\$\{sessionToken\}`/);
	assert.match(indexSrc, /activeCurators\.set\(commandCallId, handle\)/);
	assert.match(indexSrc, /glimpseWins\.set\(commandCallId, win\)/);
});
