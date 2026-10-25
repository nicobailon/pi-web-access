import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-access-exa-metadata-"));
delete process.env.EXA_BASE_URL;
delete process.env.EXA_API_KEY;
const { searchWithExa } = await import(new URL("../exa.ts", import.meta.url).href);
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.EXA_API_KEY;
});

function searchWith(responseBody, { keyed = true, args = ["query", {}] } = {}) {
	if (keyed) process.env.EXA_API_KEY = "exa-metadata-key";
	globalThis.fetch = async () => new Response(responseBody, { status: 200, headers: { "content-type": "application/json" } });
	return searchWithExa(...args);
}

const paper = {
	title: "Lessons learnt from evaluating full-scale ammonium feedback control",
	url: "https://doi.org/10.2166/wst.2014.061",
	publishedDate: "2014-02-07T00:00:00.000Z",
	author: "Linda Åmand, C. Laurell, Kristina Stark-Fujii, A. Thunberg, Bengt Carlsson",
	highlights: ["Three large wastewater treatment plants in Sweden evaluate ammonium feedback controllers."],
	entities: [{
		id: "https://exa.ai/library/publication/kfv17d5jmb1",
		type: "publication",
		properties: {
			year: 2014,
			date: "2014-02-07",
			citationCount: 14,
			authors: [{ name: "Linda Åmand" }, { name: "C. Laurell" }, { name: "Kristina Stark-Fujii" }, { name: "A. Thunberg" }, { name: "Bengt Carlsson" }],
			doi: "10.2166/wst.2014.061",
		},
	}],
};

test("keyed Exa publication results list date, first authors, citation count, and DOI", async () => {
	const result = await searchWith(JSON.stringify({ results: [paper] }), { args: ["aeration control", { category: "publication" }] });
	assert.equal(
		result.answer,
		"Three large wastewater treatment plants in Sweden evaluate ammonium feedback controllers.\n"
			+ "Source: Lessons learnt from evaluating full-scale ammonium feedback control (https://doi.org/10.2166/wst.2014.061)\n"
			+ "Published: 2014-02-07 | Authors: Linda Åmand, C. Laurell, Kristina Stark-Fujii et al. | Citations: 14 | DOI: 10.2166/wst.2014.061",
	);
});

test("keyed Exa web results list date and author, and results without metadata keep the plain source line", async () => {
	const result = await searchWith(JSON.stringify({
		results: [
			{ title: "Blog post", url: "https://example.com/post", publishedDate: "2026-10-01T12:00:00.000Z", author: "Jane Doe", highlights: ["Post text."] },
			{ title: "Undated", url: "https://example.org/page", author: "", highlights: ["Page text."] },
			{ title: "Year only", url: "https://example.net/paper", highlights: ["Paper text."], entities: [{ type: "publication", properties: { year: 1974, citationCount: 0 } }] },
			{ title: "Company", url: "https://example.io", highlights: ["Company text."], entities: [{ type: "company", properties: { citationCount: 99 } }] },
		],
	}));
	assert.equal(result.answer, [
		"Post text.\nSource: Blog post (https://example.com/post)\nPublished: 2026-10-01 | Authors: Jane Doe",
		"Page text.\nSource: Undated (https://example.org/page)",
		"Paper text.\nSource: Year only (https://example.net/paper)\nPublished: 1974 | Citations: 0",
		"Company text.\nSource: Company (https://example.io)",
	].join("\n\n"));
	assert.deepEqual(result.results.map(r => r.url), ["https://example.com/post", "https://example.org/page", "https://example.net/paper", "https://example.io"]);
});

test("keyless Exa MCP text results list the published date and authors and skip N/A", async () => {
	const text = [
		"Title: Paper A\nURL: https://doi.org/10.1/a\nPublished: 2015-01-01T00:00:00.000Z\nAuthor: A. One, B. Two, C. Three, D. Four\nHighlights:\nFirst highlight.",
		"Title: Page B\nURL: https://example.com/b\nPublished: N/A\nAuthor: N/A\nHighlights:\nSecond highlight.",
		"Title: Page C\nURL: https://example.com/c\nText: An article quoting a paper.\nAuthor: Quoted Person\nPublished: 1999-01-01",
	].join("\n\n---\n\n");
	const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } })}\n\n`;
	const result = await searchWith(body, { keyed: false });
	assert.equal(result.answer, [
		"First highlight.\nSource: Paper A (https://doi.org/10.1/a)\nPublished: 2015-01-01 | Authors: A. One, B. Two, C. Three et al.",
		"Second highlight.\nSource: Page B (https://example.com/b)",
		"An article quoting a paper. Author: Quoted Person Published: 1999-01-01\nSource: Page C (https://example.com/c)",
	].join("\n\n"));
});
