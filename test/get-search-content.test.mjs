import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";

import initializeExtension from "../index.ts";
import { buildResearchArtifact, storeResearchArtifact } from "../source-check.ts";
import { clearResults, storeResult } from "../storage.ts";

function getContentTool() {
	clearResults();
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
	});
	const tool = tools.find((registered) => registered.name === "get_search_content");
	assert.ok(tool, "get_search_content tool was not registered");
	return tool;
}

function storeFetchedContent(content) {
	storeResult("large-fetch", {
		id: "large-fetch",
		type: "fetch",
		timestamp: Date.now(),
		urls: [{
			url: "https://example.com/large",
			title: "Large Page",
			content,
			error: null,
		}],
	});
}

function storeSearchContent() {
	storeResult("search-result", {
		id: "search-result",
		type: "search",
		timestamp: Date.now(),
		queries: [{
			query: "CotEditor scripts",
			answer: "",
			results: [
				{ title: "ScriptManager.swift", url: "https://example.com/script-manager", snippet: "UNIX script support" },
				{ title: "UNIX script", url: "https://example.com/unix-script", snippet: "Script support" },
				{ title: "ScriptMenu", url: "https://example.com/script-menu", snippet: "Menu integration" },
			],
			error: null,
		}],
	});
}

test("get_search_content schemas constrain numeric parameters", () => {
	const properties = getContentTool().parameters.properties;

	for (const name of ["queryIndex", "urlIndex", "offset"]) {
		assert.equal(properties[name].type, "integer");
		assert.equal(properties[name].minimum, 0);
		assert.equal(properties[name].maximum, undefined);
		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(Value.Check(properties[name], value), false, `${name} accepts ${value}`);
		}
	}

	assert.equal(properties.limit.type, "integer");
	assert.equal(properties.limit.minimum, 1);
	assert.equal(properties.limit.maximum, 30_000);
	for (const value of [0, 1.5, 30_001, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(Value.Check(properties.limit, value), false, `limit accepts ${value}`);
	}
	for (const value of [1, 30_000]) {
		assert.equal(Value.Check(properties.limit, value), true, `limit rejects ${value}`);
	}
});

test("get_search_content returns a bounded first slice for large fetched content", async () => {
	const tool = getContentTool();
	storeFetchedContent("A".repeat(30_000) + "TAIL");

	const result = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0 });
	const text = result.content[0].text;

	assert.equal(result.details.contentLength, 30_004);
	assert.equal(result.details.offset, 0);
	assert.equal(result.details.returnedChars, 30_000);
	assert.equal(result.details.nextOffset, 30_000);
	assert.equal(result.details.truncated, true);
	assert.match(text, /Showing chars 0-30000 of 30004/);
	assert.match(text, /offset: 30000/);
	assert.doesNotMatch(text, /TAIL/);
});

test("get_search_content returns requested fetched content slices", async () => {
	const tool = getContentTool();
	storeFetchedContent("A".repeat(30_000) + "BCDEFGHIJ");

	const result = await tool.execute("call", {
		responseId: "large-fetch",
		url: "https://example.com/large",
		offset: 30_000,
		limit: 5,
	});
	const text = result.content[0].text;

	assert.equal(result.details.offset, 30_000);
	assert.equal(result.details.limit, 5);
	assert.equal(result.details.returnedChars, 5);
	assert.equal(result.details.nextOffset, 30_005);
	assert.match(text, /BCDEF/);
	assert.doesNotMatch(text, /GHIJ/);
	assert.match(text, /urlIndex: 0, offset: 30005, limit: 5/);
});

test("get_search_content rejects unsafe fetched content ranges", async () => {
	const tool = getContentTool();
	storeFetchedContent("short content");

	const tooLarge = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0, limit: 30_001 });
	assert.equal(tooLarge.details.error, "Invalid limit");
	assert.match(tooLarge.content[0].text, /received 30001/);
	assert.match(tooLarge.content[0].text, /limit must be an integer from 1 to 30000/);

	const invalidOffset = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0, offset: 1.5 });
	assert.equal(invalidOffset.details.error, "Invalid offset");
	assert.match(invalidOffset.content[0].text, /received 1\.5/);
	assert.match(invalidOffset.content[0].text, /Use 0 or a larger integer/);

	const outOfRange = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0, offset: 99 });
	assert.equal(outOfRange.details.error, "Offset out of range");
	assert.match(outOfRange.content[0].text, /Received offset 99/);
	assert.match(outOfRange.content[0].text, /valid range is 0-13/);

	const missingFindText = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0, findMode: "fuzzy" });
	assert.equal(missingFindText.details.error, "findMode requires findText");
	assert.match(missingFindText.content[0].text, /findMode "fuzzy" requires findText/);

	const artifact = buildResearchArtifact({
		query: "stored claim",
		results: [{ url: "https://example.com/research", title: "Research source", snippet: "The bridge defaults match this research passage.", rank: 1 }],
		summary: "Unique bridge research summary marker.",
	});
	artifact.id = "stored-research";
	storeResearchArtifact(artifact);
	const researchInvalidLimit = await tool.execute("call", { responseId: "stored-research", limit: 30_001 });
	assert.equal(researchInvalidLimit.details.error, "Invalid limit");
	assert.match(researchInvalidLimit.content[0].text, /received 30001/);
	assert.match(researchInvalidLimit.content[0].text, /limit must be an integer from 1 to 30000/);

	const researchOutOfRange = await tool.execute("call", { responseId: "stored-research", offset: 99_999 });
	assert.equal(researchOutOfRange.details.error, "Offset out of range");
	assert.match(researchOutOfRange.content[0].text, /responseId "stored-research"/);
	assert.match(researchOutOfRange.content[0].text, /valid range is 0-/);

	const researchFind = await tool.execute("call", {
		responseId: "stored-research",
		offset: 0,
		limit: 10_000,
		findText: "Unique bridge research summary marker",
	});
	assert.equal(researchFind.details.type, "research");
	assert.equal(researchFind.details.findMode, "case-insensitive");
	assert.equal(researchFind.details.matchCount, 1);
	assert.match(researchFind.content[0].text, /^Text matches \(case-insensitive\)/);
	assert.match(researchFind.content[0].text, /Unique bridge research summary marker/);
});

test("get_search_content normalizes bridge defaults for search matches", async () => {
	const tool = getContentTool();
	storeSearchContent();

	const result = await tool.execute("call", {
		responseId: "search-result",
		query: "",
		queryIndex: 0,
		url: "",
		urlIndex: 0,
		offset: 0,
		limit: 10_000,
		findText: ["ScriptManager.swift", "UNIX script", "ScriptMenu"],
		findMode: "case-insensitive",
	});

	assert.equal(result.details.findMode, "case-insensitive");
	assert.equal(result.details.matchCount, 4);
	assert.match(result.content[0].text, /ScriptManager\.swift/);
	assert.match(result.content[0].text, /ScriptMenu/);
});

test("get_search_content pages complete search data and validates search ranges", async () => {
	const tool = getContentTool();
	const lateSnippet = `LATE_SNIPPET_${"S".repeat(116_000)}`;
	const source = {
		query: "oversized stored search",
		answer: `answer ${"A".repeat(40_000)} OMITTED_ANSWER`,
		results: [
			{ title: "First", url: "https://example.com/first", snippet: "first snippet" },
			{ title: "Late", url: "https://example.com/late", snippet: lateSnippet },
		],
		error: null,
		provider: "fixture-provider",
	};
	storeResult("oversized-search", { id: "oversized-search", type: "search", timestamp: Date.now(), queries: [source] });

	const first = await tool.execute("call", { responseId: "oversized-search", queryIndex: 0, limit: 30_000 });
	assert.equal(first.details.returnedChars, 30_000);
	assert.equal(first.details.nextOffset, 30_000);
	assert.equal(first.details.truncated, true);
	assert.ok(first.details.contentLength > 156_000);
	assert.match(first.content[0].text, /Provider:\*\* fixture-provider/);
	assert.doesNotMatch(first.content[0].text, /LATE_SNIPPET/);

	const late = await tool.execute("call", {
		responseId: "oversized-search",
		queryIndex: 0,
		findText: ["OMITTED_ANSWER", "LATE_SNIPPET"],
		findMode: "exact",
	});
	assert.equal(late.details.matchCount, 2);
	assert.match(late.content[0].text, /OMITTED_ANSWER/);
	assert.match(late.content[0].text, /LATE_SNIPPET/);
	assert.equal(source.answer.length, 40_022);
	assert.equal(source.results[1].snippet, lateSnippet);

	const invalidLimit = await tool.execute("call", { responseId: "oversized-search", queryIndex: 0, limit: 30_001 });
	assert.equal(invalidLimit.details.error, "Invalid limit");
	const invalidOffset = await tool.execute("call", { responseId: "oversized-search", queryIndex: 0, offset: -1 });
	assert.equal(invalidOffset.details.error, "Invalid offset");
	const outOfRange = await tool.execute("call", { responseId: "oversized-search", queryIndex: 0, offset: first.details.contentLength + 1 });
	assert.equal(outOfRange.details.error, "Offset out of range");
});

test("get_search_content returns small fetched content without continuation noise", async () => {
	const tool = getContentTool();
	storeFetchedContent("small content");

	const result = await tool.execute("call", { responseId: "large-fetch", urlIndex: 0 });
	const text = result.content[0].text;

	assert.equal(result.details.returnedChars, "small content".length);
	assert.equal(result.details.nextOffset, null);
	assert.match(text, /small content/);
	assert.doesNotMatch(text, /Showing chars/);
});

test("get_search_content finds bounded passages in stored fetched content", async () => {
	const tool = getContentTool();
	storeFetchedContent(`prefix ${"A".repeat(2_000)} Installation requires Node 22. ${"B".repeat(2_000)} suffix`);

	const result = await tool.execute("call", {
		responseId: "large-fetch",
		query: "",
		queryIndex: 0,
		url: "",
		urlIndex: 0,
		offset: 0,
		limit: 10_000,
		findText: "installation",
	});

	assert.equal(result.details.matchCount, 1);
	assert.equal(result.details.findMode, "case-insensitive");
	assert.match(result.content[0].text, /Installation requires Node 22/);
	assert.ok(result.content[0].text.length < 1_000);
});

test("get_search_content represents every matching maximum-length query under overflow", async () => {
	const tool = getContentTool();
	const sequence = "a".repeat(499) + "0123456789";
	const queries = Array.from({ length: 10 }, (_, index) => sequence.slice(index, index + 500));
	const gap = "Z".repeat(1_000);
	const occurrence = query => `${"x".repeat(500)}${query}${"x".repeat(500)}`;
	const content = [
		...queries.slice(0, 9).map(occurrence),
		sequence,
		occurrence(queries[0]),
		occurrence(queries[1]),
		occurrence(queries[9]),
	].join(gap);
	storeFetchedContent(content);

	assert.equal(new Set(queries).size, 10);
	assert.ok(queries.every(query => query.length === 500));
	assert.equal(Value.Check(tool.parameters.properties.findText, queries), true);
	const result = await tool.execute("call", {
		responseId: "large-fetch",
		urlIndex: 0,
		findText: queries,
		findMode: "exact",
	});
	const excerpts = result.content[0].text.split("\n\n").slice(1).join("\n\n");

	assert.equal(result.details.matchCount, 22);
	assert.ok(result.details.returnedMatches <= result.details.matchCount);
	const snippets = excerpts.split("\n\n").filter(section => /^\d+\. /.test(section))
		.map(section => section.split("\n").slice(1).join("\n")).join("");
	for (const [index, query] of queries.entries()) {
		assert.ok(excerpts.includes(`Q${index + 1} = "${query}"`), "missing legend entry");
		assert.ok(snippets.includes(query), "missing representative occurrence");
	}
	if (result.details.returnedMatches < result.details.matchCount) {
		assert.match(excerpts, /Showing \d+ of 22 matches\./);
	}
	assert.ok(excerpts.length <= 20_000);
});
