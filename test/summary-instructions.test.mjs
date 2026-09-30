import assert from "node:assert/strict";
import { test } from "node:test";

const summaryUrl = new URL("../summary-review.ts", import.meta.url).href;

test("custom summary instructions are appended to the Requirements section", async () => {
	const { buildSummaryPrompt } = await import(summaryUrl);
	const instructions = "- List EVERY source URL found.\n- Preserve all concrete figures verbatim.";
	const prompt = buildSummaryPrompt([], undefined, instructions);
	assert.ok(prompt.includes("- List EVERY source URL found."));
	assert.ok(prompt.includes("- Preserve all concrete figures verbatim."));
	assert.ok(prompt.indexOf("- List EVERY source URL found.") < prompt.indexOf("<search_results>"));
	// Default guardrails stay in place; instructions are additive, not a replacement.
	assert.ok(prompt.includes("- Do not invent sources or claims."));
	assert.ok(prompt.includes("- If evidence is weak or conflicting, say so explicitly."));
});

test("absent, non-string, and blank instructions keep the default prompt unchanged", async () => {
	const { buildSummaryPrompt } = await import(summaryUrl);
	const baseline = buildSummaryPrompt([]);
	assert.equal(buildSummaryPrompt([], undefined, undefined), baseline);
	assert.equal(buildSummaryPrompt([], undefined, "   \n\t"), baseline);
	assert.equal(buildSummaryPrompt([], undefined, 42), baseline);
});

test("instructions and curator feedback coexist", async () => {
	const { buildSummaryPrompt } = await import(summaryUrl);
	const prompt = buildSummaryPrompt([], "focus on pricing", "- List EVERY source URL found.");
	assert.ok(prompt.includes("focus on pricing"));
	assert.ok(prompt.includes("- List EVERY source URL found."));
	assert.ok(prompt.indexOf("- List EVERY source URL found.") < prompt.indexOf("<user_feedback>"));
});
