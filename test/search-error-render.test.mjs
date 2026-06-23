// Repro + guard for the web_search Ctrl+O error-path dead-end (ronin fix).
//
// BEFORE the fix, web_search renderResult early-returned a SINGLE line on the
// error/cancel path (before the collapsed/expanded branch), so Ctrl+O flipped
// `expanded` with zero visible effect and discarded the partial results. This
// test pins the new behavior: the error/cancel path produces a rich, EXPANDABLE
// plan (>1 line, with diagnostics + a "ctrl+o to expand" hint), routed through
// the dep-free buildSearchErrorPlan() that index.ts.renderResult delegates to.
//
// Runner: node --test (matches the package's existing .test.mjs convention).
// Node >= 22.6 imports the .ts source directly (no build step).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildSearchErrorPlan } from "../render-search-error.ts";

// --- fixture: a stale cancel with partial results, mirroring the user's report
// ("Search curation cancelled (stale)" with 2/3 queries done, one errored,
//  browser never connected). ---
const staleCancel = {
	error: "Search curation cancelled (stale).",
	cancelled: true,
	cancelReason: "stale",
	browserConnected: false,
	lastHeartbeatAgeMs: 31200,
	queryCount: 3,
	cancelledQueries: [
		{ query: "z.ai API usage endpoint coding plan credits", provider: "perplexity", error: null, resultCount: 5 },
		{ query: "z.ai GLM coding plan API key usage limits", provider: "perplexity", error: "Connection error", resultCount: 0 },
	],
};

test("cancel/error path is NOT a dead-end single line: expanded plan has >1 line", () => {
	const plan = buildSearchErrorPlan(staleCancel);
	assert.notEqual(plan, null, "a cancelled result must produce a plan, not null");
	const expanded = plan.expanded.join("\n");
	// The dead-end was exactly ONE line. Pin that the expanded view is rich.
	assert.ok(plan.expanded.length > 1, `expanded must be >1 line, got ${plan.expanded.length}`);
	assert.match(expanded, /Search curation cancelled \(stale\)/);
});

test("expanded plan surfaces the diagnostics that were previously discarded", () => {
	const plan = buildSearchErrorPlan(staleCancel);
	const expanded = plan.expanded.join("\n");
	// cancel reason
	assert.match(expanded, /cancel reason\s*:\s*stale/);
	// browser state — the #1 stale cause, previously invisible
	assert.match(expanded, /browser\s*:\s*never connected/);
	// query progress (2 of 3 done)
	assert.match(expanded, /queries started\s*:\s*3/);
	assert.match(expanded, /queries done\s*:\s*2/);
	// per-query results: the completed one (with source count) AND the errored one
	assert.match(expanded, /z\.ai API usage endpoint/);
	assert.match(expanded, /5 sources/);
	assert.match(expanded, /\[err\]/);
	assert.match(expanded, /Connection error/);
});

test("collapsed view is a short summary WITH a ctrl+o expand hint (Ctrl+O now does something)", () => {
	const plan = buildSearchErrorPlan(staleCancel);
	// collapsed preview summarizes progress + browser state
	const collapsed = plan.collapsed.join("\n");
	assert.match(collapsed, /2\/3 queries completed/);
	assert.match(collapsed, /browser never connected/);
	// THE fix signal: an expand hint exists (the old single-line return had none,
	// so Ctrl+O did nothing). Mutation: dropping the hint fails here.
	assert.equal(typeof plan.expandHint, "string");
	assert.match(plan.expandHint, /ctrl\+o to expand/i, "expand hint must mention ctrl+o");
	// and the hint correctly counts the hidden lines
	assert.match(plan.expandHint, /\d+ more lines/);
});

test("plain (non-cancel) error stays a clean single line — no diagnostic noise", () => {
	// A bare argument error has nothing to diagnose; it must NOT sprout fake
	// "browser: unknown" diagnostics. Guards the gating logic in the module.
	const plan = buildSearchErrorPlan({ error: "No query provided" });
	assert.notEqual(plan, null);
	assert.equal(plan.expanded.length, 1, "plain error must be a single line");
	assert.equal(plan.collapsed.length, 0);
	assert.equal(plan.expandHint, null, "plain error must have no expand hint");
});

// --- other tools (code_search / fetch_content / get_search_content): the same
// dead-end exists in their renderResults; they now reuse buildSearchErrorPlan via
// extraLines. These pin that non-cancel errors with detail become expandable
// WITHOUT the curator/browser diagnostics (which are web_search-only). ---

test("fetch_content-style error (extras, no cancel) is expandable without browser diagnostics", () => {
	const plan = buildSearchErrorPlan({
		error: "Failed to fetch: https://example.com/x (404)",
		extraLines: ["urls: 1/2 succeeded", "response id: resp_abc", "  \u25b8 https://example.com/x"],
	});
	assert.notEqual(plan, null);
	const expanded = plan.expanded.join("\n");
	assert.ok(plan.expanded.length > 1);
	assert.match(expanded, /urls: 1\/2 succeeded/);
	assert.match(expanded, /resp_abc/);
	// MUST NOT show curator/browser diagnostics for a non-cancel error.
	assert.doesNotMatch(expanded, /browser|cancel reason|queries started/);
	assert.equal(typeof plan.expandHint, "string");
	assert.match(plan.expandHint, /ctrl\+o to expand/i);
});

test("code_search-style error with a failed query shows the query in extras", () => {
	const plan = buildSearchErrorPlan({
		error: "Exa search failed: connection reset",
		extraLines: ["query: how to use p-limit concurrency"],
	});
	assert.notEqual(plan, null);
	assert.match(plan.expanded.join("\n"), /query: how to use p-limit concurrency/);
	assert.doesNotMatch(plan.expanded.join("\n"), /browser/);
	assert.equal(typeof plan.expandHint, "string");
});

test("error with NO extras and NO cancel stays single-line (code_search without query)", () => {
	// e.g. code_search with no query arg — nothing to diagnose.
	const plan = buildSearchErrorPlan({ error: "Some transient error" });
	assert.notEqual(plan, null);
	assert.equal(plan.expanded.length, 1);
	assert.equal(plan.expandHint, null);
});

test("non-error result yields null so the caller falls through to the success renderer", () => {
	assert.equal(buildSearchErrorPlan({ queryCount: 3, totalResults: 9 }), null);
	assert.equal(buildSearchErrorPlan(undefined), null);
	assert.equal(buildSearchErrorPlan(null), null);
});

// --- source-contract guard: index.ts web_search renderResult must DELEGATE to
// buildSearchErrorPlan on the error path (mutation-proof against reverting the
// integration back to the dead-end single-line return). ---
const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const indexSrc = readFileSync(indexPath, "utf8");

test("index.ts imports buildSearchErrorPlan and wires it into the web_search error path", () => {
	assert.match(indexSrc, /import \{ buildSearchErrorPlan, type SearchErrorDetails, type SearchErrorPlan \} from "\.\/render-search-error\.ts";/);
	// The web_search renderResult error branch must call buildSearchErrorPlan.
	// (Mutation: reverting renderResult to `return new Text(error...)` drops this.)
	assert.match(indexSrc, /buildSearchErrorPlan\(details as SearchErrorDetails\)/);
	// buildCurationCancelledReturn must now carry partial diagnostics into details
	// (mutation: dropping the partial arg reverts to the discarded-results bug).
	assert.match(indexSrc, /buildCurationCancelledReturn\(reason, \{/);
	assert.match(indexSrc, /cancelledQueries/);
	// the 3 other tools must also delegate to buildSearchErrorPlan (mutation-proof:
	// reverting any of them to the bare single-line drops its buildSearchErrorPlan call).
	// Count call sites: web_search + code_search + fetch_content + get_search_content = 4.
	const callSiteCount = (indexSrc.match(/const plan = buildSearchErrorPlan\(/g) || []).length;
	assert.equal(callSiteCount, 4, `expected 4 buildSearchErrorPlan call sites, got ${callSiteCount}`);
	// renderSearchErrorPlan shared renderer is used by all 4.
	const renderCount = (indexSrc.match(/return renderSearchErrorPlan\(plan, expanded, theme\)/g) || []).length;
	assert.equal(renderCount, 4, `expected 4 renderSearchErrorPlan returns, got ${renderCount}`);
});
