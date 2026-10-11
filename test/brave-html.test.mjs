import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Brave titles and snippets arrive without markup", async () => {
	const original = globalThis.fetch;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = await mkdtemp(join(tmpdir(), "pi-web-brave-html-"));
	process.env.PI_CODING_AGENT_DIR = home;
	globalThis.fetch = async () => new Response(JSON.stringify({
		web: { results: [{
			title: "Node.js &mdash; <strong>fs</strong> module",
			url: "https://nodejs.org/api/fs.html",
			description: "Work with files &amp; directories <strong>fast</strong> &#x110000;",
		}] },
	}), { status: 200 });
	process.env.BRAVE_API_KEY = "test-key";
	try {
		const { searchWithBrave } = await import(`../brave.ts?html=${Date.now()}`);
		const { results } = await searchWithBrave("fs module");

		assert.equal(results[0].title, "Node.js — fs module");
		assert.equal(results[0].snippet, "Work with files & directories fast &#x110000;");
	} finally {
		globalThis.fetch = original;
		delete process.env.BRAVE_API_KEY;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		await rm(home, { recursive: true, force: true });
	}
});
