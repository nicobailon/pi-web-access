import assert from "node:assert/strict";
import { test } from "node:test";

import { findContent } from "../content-find.ts";

test("findContent supports exact, case-insensitive, and fuzzy matches", () => {
	const text = "Alpha configuration guide.\n\nThe server configuraton value is 42.";

	assert.equal(findContent(text, ["configuration"], "exact").matchCount, 1);
	assert.equal(findContent(text, ["ALPHA"], "case-insensitive").matchCount, 1);
	assert.equal(findContent(text, ["configuration value"], "fuzzy").matchCount, 1);
});

test("findContent caps the complete formatted response", () => {
	const query = "x".repeat(500);
	const text = Array.from(
		{ length: 30 },
		(_, index) => `${"a".repeat(500)} ${query} ${"b".repeat(500)} ${index}`,
	).join("\n\n");
	const result = findContent(text, [query], "exact");

	assert.equal(result.matchCount, 30);
	assert.ok(result.returnedMatches > 0);
	assert.ok(result.returnedMatches < result.matchCount);
	assert.ok(result.text.length <= 20_000);
});

for (const mode of ["exact", "case-insensitive", "fuzzy"]) {
	test(`findContent returns excerpts for densely overlapping ${mode} matches`, () => {
		const text = "common context for this occurrence.\n\n".repeat(4_000);
		const result = findContent(text, ["common"], mode);
		assert.equal(result.matchCount, 4_000);
		assert.ok(result.returnedMatches > 0);
		assert.ok(result.returnedMatches < result.matchCount);
		assert.match(result.text, /common context/);
		assert.match(result.text, new RegExp(`Showing ${result.returnedMatches} of 4000 matches\\.`));
		assert.ok(result.text.length <= 20_000);
	});
}

for (const sparse of [false, true]) {
	for (const queries of [["common", "RareTarget"], ["RareTarget", "common"]]) {
		test(`findContent includes rare-query context with ${sparse ? "sparse" : "dense"} common matches and ${queries[0]} first`, () => {
			const text = (`common ${"x".repeat(sparse ? 1_000 : 20)}\n`).repeat(sparse ? 80 : 4_000)
				+ "x".repeat(2_000) + "RareTarget has important context.";
			const result = findContent(text, queries, "exact");
			assert.equal(result.matchCount, sparse ? 81 : 4_001);
			assert.ok(result.returnedMatches > 1);
			assert.match(result.text, /common/);
			assert.match(result.text, /RareTarget has important context\./);
			assert.equal(result.queryResults.find(item => item.query === "RareTarget").matchCount, 1);
			assert.ok(result.text.length <= 20_000);
		});
	}
}

test("findContent preserves document order and formatting when all excerpts fit", () => {
	const text = "common first." + "x".repeat(1_000) + "common second."
		+ "x".repeat(1_000) + "RareTarget last.";
	const result = findContent(text, ["common", "RareTarget"], "exact");
	assert.equal(result.returnedMatches, 3);
	assert.equal(result.text, [
		"Text matches (exact)",
		`1. "common" ×1\n${text.slice(0, 406)}…`,
		`2. "common" ×1\n…${text.slice(613, 1_419)}…`,
		`3. "RareTarget" ×1\n…${text.slice(1_627)}`,
	].join("\n\n"));
});

test("findContent measures formatted output rather than raw whitespace", () => {
	const text = ("common" + " ".repeat(500)).repeat(99) + "common";
	const result = findContent(text, ["common"], "exact");
	assert.equal(result.returnedMatches, 100);
	assert.equal(result.text, `Text matches (exact)\n\n1. "common" ×100\n${text.replace(/\s+/g, " ").trim()}`);
});

test("findContent preserves missing-query and truncation notices under overflow", () => {
	const text = "common context.\n\n".repeat(4_000);
	const missing = "z".repeat(500);
	const result = findContent(text, [" common ", "common", missing], "exact");
	assert.equal(result.queryResults.length, 2);
	assert.equal(result.matchCount, 4_000);
	assert.ok(result.returnedMatches > 0);
	assert.ok(result.returnedMatches <= result.matchCount);
	assert.ok(result.text.includes(`No matches: "${missing}"`));
	assert.match(result.text, /Showing \d+ of 4000 matches\./);
	assert.ok(result.text.length <= 20_000);
});

test("findContent bounds output with ten maximum-length query labels", () => {
	const queries = Array.from({ length: 10 }, (_, index) => `${index}${"q".repeat(499)}`);
	const text = queries.map(query => `${query} ${"x".repeat(500)} `).join("").repeat(30);
	const result = findContent(text, queries, "exact");
	assert.equal(result.matchCount, 300);
	assert.ok(result.returnedMatches > 0);
	assert.ok(result.returnedMatches < 300);
	assert.ok(result.text.length <= 20_000);
	assert.match(result.text, /Showing \d+ of 300 matches\./);
});
