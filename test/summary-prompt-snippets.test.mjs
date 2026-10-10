import assert from "node:assert/strict";
import test from "node:test";
import { buildSummaryPrompt } from "../summary-review.ts";

const source = (snippet) => ({ title: "Source", url: "https://example.com/a", snippet });

test("sources carry their snippets into the prompt", () => {
	const prompt = buildSummaryPrompt([
		{ query: "q", provider: "brave", answer: "", results: [source("the evidence sentence")] },
	]);

	assert.match(prompt, /the evidence sentence/);
});

test("snippets are bounded, and tighter when the provider already answered", () => {
	const long = "x".repeat(2000);
	const withAnswer = buildSummaryPrompt([
		{ query: "q", provider: "tavily", answer: "provider answer", results: [source(long)] },
	]);
	const withoutAnswer = buildSummaryPrompt([
		{ query: "q", provider: "brave", answer: "", results: [source(long)] },
	]);

	assert.ok(withAnswer.includes("x".repeat(200)) && !withAnswer.includes("x".repeat(201)));
	assert.ok(withoutAnswer.includes("x".repeat(600)) && !withoutAnswer.includes("x".repeat(601)));
});
