import assert from "node:assert/strict";
import test from "node:test";

test("Brave titles and snippets arrive without markup", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		web: { results: [{
			title: "Node.js &mdash; <strong>fs</strong> module",
			url: "https://nodejs.org/api/fs.html",
			description: "Work with files &amp; directories <strong>fast</strong>",
		}] },
	}), { status: 200 });
	process.env.BRAVE_API_KEY = "test-key";
	try {
		const { searchWithBrave } = await import(`../brave.ts?html=${Date.now()}`);
		const { results } = await searchWithBrave("fs module");

		assert.equal(results[0].title, "Node.js — fs module");
		assert.equal(results[0].snippet, "Work with files & directories fast");
	} finally {
		globalThis.fetch = original;
		delete process.env.BRAVE_API_KEY;
	}
});
