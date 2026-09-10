import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveWebSearchWorkflow } from "../curator-run.ts";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("web_search accepts auto-summary workflow in schema and config resolution", () => {
	assert.match(indexSrc, /StringEnum\(\["none", "summary-review", "auto-summary"\]/);
	assert.equal(resolveWebSearchWorkflow("auto-summary", true), "auto-summary");
	assert.match(indexSrc, /arg === "none" \|\| arg === "summary-review" \|\| arg === "auto-summary"/);
});

test("auto-summary skips curator and reuses summary model fallback plumbing", () => {
	assert.match(indexSrc, /const shouldCurate = workflow === "summary-review"/);
	assert.match(indexSrc, /if \(workflow === "auto-summary"\)/);
	assert.match(indexSrc, /await loadSummaryModelChoices\(summaryContext\)/);
	assert.match(indexSrc, /const parsed = splitThinkingSuffix\(selector\)/);
	assert.match(indexSrc, /summaryModels\.push\(\{ value: selector, label: selector \}\)/);
	assert.match(indexSrc, /return selector/);
	assert.match(indexSrc, /await generateSummaryDraft\(\s*searchResults,\s*summaryContext,\s*signal,\s*summaryModelChoices\.defaultSummaryModel \?\? undefined,\s*undefined,\s*undefined,\s*getSummaryGenerationDeadlineMs\(\),\s*\)/);
	assert.match(indexSrc, /workflow: workflow === "auto-summary" \? "auto-summary" : undefined/);
});

test("README documents auto-summary", () => {
	assert.match(readmeSrc, /workflow: "auto-summary"/);
	assert.match(readmeSrc, /generate a summary without opening the curator/);
});
