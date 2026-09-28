import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;

async function runKeyedExa(calls) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-transport-"));
	try {
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, EXA_API_KEY: "exa-transport-key" };
		delete env.EXA_BASE_URL;
		delete env.XDG_CONFIG_HOME;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const requests = [];
				globalThis.fetch = async (url, init) => {
					requests.push({ url: String(url), method: init.method, apiKey: init.headers["x-api-key"], body: JSON.parse(init.body) });
					return new Response(JSON.stringify({ results: [
						{ title: "Exa Docs", url: "https://exa.ai/docs", text: "full docs text", highlights: ["docs highlight"] },
						{ url: "https://exa.ai/untitled", highlights: [] },
					] }), { status: 200, headers: { "content-type": "application/json" } });
				};
				const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
				const results = [];
				for (const args of ${JSON.stringify(calls)}) results.push(await searchWithExa(...args));
				console.log(JSON.stringify({ requests, results }));
			`,
			encoding: "utf8",
			env,
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("keyed Exa default and explicit five-result searches post to /search, never /answer", async () => {
	const { requests, results } = await runKeyedExa([["default query"], ["explicit five", { numResults: 5 }]]);

	assert.deepEqual(requests.map(({ url, method, apiKey }) => ({ url, method, apiKey })), [
		{ url: "https://api.exa.ai/search", method: "POST", apiKey: "exa-transport-key" },
		{ url: "https://api.exa.ai/search", method: "POST", apiKey: "exa-transport-key" },
	]);
	assert.deepEqual(requests.map(({ body }) => body), [
		{ query: "default query", type: "auto", numResults: 5, contents: { highlights: true } },
		{ query: "explicit five", type: "auto", numResults: 5, contents: { highlights: true } },
	]);
	for (const result of results) {
		assert.deepEqual(result, {
			answer: "docs highlight\nSource: Exa Docs (https://exa.ai/docs)",
			results: [
				{ title: "Exa Docs", url: "https://exa.ai/docs", snippet: "" },
				{ title: "exa.ai", url: "https://exa.ai/untitled", snippet: "" },
			],
		});
	}
});

test("keyed Exa filtered searches keep filters and inline content on /search", async () => {
	const { requests, results } = await runKeyedExa([["filtered", {
		numResults: 3,
		recencyFilter: "week",
		domainFilter: ["exa.ai", "-spam.example"],
		includeContent: true,
	}]]);

	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "https://api.exa.ai/search");
	const { startPublishedDate, ...body } = requests[0].body;
	assert.ok(Number.isFinite(Date.parse(startPublishedDate)));
	assert.deepEqual(body, {
		query: "filtered",
		type: "auto",
		numResults: 3,
		includeDomains: ["exa.ai"],
		excludeDomains: ["spam.example"],
		contents: { text: true, highlights: true },
	});
	assert.deepEqual(results[0].inlineContent, [
		{ url: "https://exa.ai/docs", title: "Exa Docs", content: "full docs text", error: null },
	]);
});
