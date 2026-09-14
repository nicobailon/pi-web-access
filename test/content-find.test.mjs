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
	assert.ok(result.returnedMatches <= result.matchCount);
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

test("findContent returns deterministic bounded dense and sparse results", () => {
	for (const [text, count] of [
		["common context.\n\n".repeat(8_192), 8_192],
		[`common${" ".repeat(900)}`.repeat(1_024), 1_024],
	]) {
		const result = findContent(text, ["common"], "exact");
		assert.equal(result.matchCount, count);
		assert.ok(result.returnedMatches > 0 && result.returnedMatches < count);
		assert.match(result.text, new RegExp(`Showing ${result.returnedMatches} of ${count} matches\\.`));
		assert.ok(result.text.length <= 20_000);
		assert.deepEqual(findContent(text, ["common"], "exact"), result);
	}
});

for (const [sparse, queries] of [[false, ["common", "RareTarget"]], [true, ["RareTarget", "common"]]]) {
	test(`findContent includes rare-query context with ${sparse ? "sparse" : "dense"} common matches`, () => {
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

test("findContent includes a near-limit missing-query notice", () => {
	const missing = "z".repeat(500);
	const result = findContent(("q" + "x".repeat(399)).repeat(49), ["q", missing], "exact");

	assert.equal(result.matchCount, 49);
	assert.equal(result.returnedMatches, 49);
	assert.match(result.text, new RegExp(`No matches: "${missing}"`));
	assert.ok(result.text.length <= 20_000);
});

test("findContent reserves one witness per nested matching query", () => {
	const common = "q".repeat(499);
	const queries = [common, ..."abcdefghi"].map((value, index) => index ? common + value : value);
	const text = queries.slice(1).map(query => query + "x".repeat(1_000)).join("");
	const result = findContent(text, queries, "exact");
	const snippets = result.text.split("\n\n").filter(section => /^\d+\. /.test(section))
		.map(section => section.split("\n").slice(1).join("\n")).join("");

	assert.equal(result.matchCount, 18);
	assert.equal(result.returnedMatches, 18);
	for (const [index, query] of queries.entries()) {
		assert.match(result.text, new RegExp(`Q${index + 1} = "${query}"`));
		assert.ok(snippets.includes(query), `missing Q${index + 1} witness`);
	}
	assert.ok(result.text.length <= 20_000);
});

test("findContent reports an oversized fuzzy witness as omitted", () => {
	const result = findContent("a" + "ʰ".repeat(25_000), ["a"], "fuzzy");

	assert.equal(result.matchCount, 1);
	assert.equal(result.returnedMatches, 0);
	assert.match(result.text, /No representative excerpt: Q1\./);
	assert.match(result.text, /Showing 0 of 1 matches\./);
	assert.ok(result.text.length <= 20_000);
});

test("findContent chooses a fitting alternate fuzzy witness", () => {
	const short = "a" + "ʰ".repeat(100);
	const overlapping = "a" + "ʰ".repeat(19_825);
	const result = findContent(`${short}\n\n${"x".repeat(1_000)}\n\n${overlapping} other`, ["a other", "a"], "fuzzy");

	assert.equal(result.matchCount, 3);
	assert.equal(result.returnedMatches, 2);
	assert.doesNotMatch(result.text, /No representative excerpt/);
	assert.match(result.text, /1\. Q1 ×1, Q2 ×1/);
	assert.match(result.text, /Showing 2 of 3 matches\./);
	assert.ok(result.text.includes(overlapping));
	assert.ok(result.text.length <= 20_000);
});

test("findContent unions overlapping witnesses and counts only contained matches", () => {
	const text = ("A" + "x".repeat(499) + "B").repeat(100);
	const queries = [text.slice(0, 500), text.slice(250, 750)];
	const result = findContent(text, queries, "exact");
	const sections = result.text.split("\n\n").filter(section => /^\d+\. /.test(section));

	assert.equal(result.matchCount, 199);
	assert.equal(result.returnedMatches, 3);
	assert.equal(sections.length, 1);
	assert.match(sections[0], /^1\. Q1 ×2, Q2 ×1\n/);
	assert.match(result.text, /Showing 3 of 199 matches\./);
	assert.ok(result.text.length <= 20_000);
});

test("findContent does not repeat context when bounded ranges split", () => {
	const query = "q".repeat(500);
	const markers = Array.from({ length: 30 }, (_, index) => `overlap-marker-${index.toString().padStart(2, "0")}`);
	const text = Array.from({ length: 30 }, (_, index) => {
		const marker = markers[index];
		const context = `${"x".repeat(50)}${marker}${"x".repeat(150 - marker.length)}`;
		return query + context;
	}).join("");
	const result = findContent(text, [query], "exact");
	const sections = result.text.split("\n\n").filter(section => /^\d+\. /.test(section));
	const snippets = sections.map(section => section.split("\n").slice(1).join("\n")).join("");
	const sectionMatches = sections.reduce((count, section) => count + Number(section.match(/×(\d+)/)?.[1] ?? 0), 0);

	assert.equal(result.matchCount, 30);
	assert.equal(sectionMatches, result.returnedMatches);
	assert.equal(snippets.split(query).length - 1, result.returnedMatches);
	assert.ok(markers.some(marker => snippets.includes(marker)));
	for (const marker of markers) assert.ok(snippets.split(marker).length - 1 <= 1, `repeated source interval at ${marker}`);
	if (result.returnedMatches < result.matchCount) {
		assert.match(result.text, new RegExp(`Showing ${result.returnedMatches} of 30 matches\\.`));
	} else {
		assert.doesNotMatch(result.text, /Showing \d+ of \d+ matches\./);
	}
	assert.ok(result.text.length <= 20_000);
});
