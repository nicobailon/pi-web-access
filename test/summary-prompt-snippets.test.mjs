import assert from "node:assert/strict";
import test from "node:test";
import { buildSummaryPrompt } from "../summary-review.ts";

const source = (snippet) => ({ title: "Source", url: "https://example.com/a", snippet });

test("snippets reach the prompt, bounded tighter when the provider already answered", () => {
	const long = "x".repeat(2000);
	const short = buildSummaryPrompt([
		{ query: "q", provider: "brave", answer: "", results: [source("the evidence sentence")] },
	]);
	const withAnswer = buildSummaryPrompt([
		{ query: "q", provider: "tavily", answer: "provider answer", results: [source(long)] },
	]);
	const withoutAnswer = buildSummaryPrompt([
		{ query: "q", provider: "brave", answer: "", results: [source(long)] },
	]);

	assert.ok(short.includes("   the evidence sentence\n"));
	assert.ok(withAnswer.includes(`   ${"x".repeat(199)}…\n`));
	assert.ok(withoutAnswer.includes(`   ${"x".repeat(599)}…\n`));
});

test("each query's snippets stay within its own budget", () => {
	const sources = Array.from({ length: 25 }, (_, i) => source(`s${i} ${"x".repeat(1000)}`));
	const prompt = buildSummaryPrompt([
		{ query: "first", provider: "brave", answer: "", results: sources },
		{ query: "second", provider: "brave", answer: "", results: sources },
	]);

	const queries = prompt.split(/\n\[Result \d+\]\n/).slice(1);
	assert.equal(queries.length, 2);
	for (const query of queries) {
		const snippets = query.split("\n").filter((line) => line.startsWith("   ")).map((line) => line.slice(3));
		assert.ok(snippets.reduce((total, snippet) => total + snippet.length, 0) <= 12_000);
		assert.equal(snippets.length, 20);
	}
});
