import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;

async function runKeyedExa(calls, costDollars, { tool = false } = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-transport-"));
	try {
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, EXA_API_KEY: "exa-transport-key" };
		delete env.EXA_BASE_URL;
		delete env.XDG_CONFIG_HOME;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const requests = [];
				const costDollars = ${JSON.stringify(costDollars)};
				globalThis.fetch = async (url, init) => {
					requests.push({ url: String(url), method: init.method, apiKey: init.headers["x-api-key"], body: JSON.parse(init.body) });
					return new Response(JSON.stringify({ ...(costDollars !== undefined ? { costDollars } : {}), results: [
						{ title: "Exa Docs", url: "https://exa.ai/docs", text: "full docs text", highlights: ["docs highlight"] },
						{ url: "https://exa.ai/untitled", highlights: [] },
					] }), { status: 200, headers: { "content-type": "application/json" } });
				};
				const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
				const tools = [];
				if (${tool}) {
					(await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
				}
				const results = [];
				for (const args of ${JSON.stringify(calls)}) {
					try {
						results.push(${tool}
							? await tools.find(t => t.name === "web_search").execute("call", { query: args[0], provider: "exa", ...args[1] }, undefined, undefined, { hasUI: false, modelRegistry: {} })
							: await searchWithExa(...args));
					}
					catch (error) { results.push({ error: error.message }); }
				}
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

test("keyed Exa sends objective unchanged and returns Exa cost", async () => {
	const objective = "  Find primary sources about the API's behavior.\nKeep their known limitations.  ";
	const costDollars = { total: 0.003, search: { neural: 0.002 }, contents: { highlights: 0.001 } };
	const { requests, results } = await runKeyedExa([["objective query", { objective }]], costDollars);
	assert.equal(requests[0].body.objective, objective);
	assert.deepEqual(results[0].exaCostDollars, costDollars);
});

test("keyed Exa accepts 4096 characters unchanged and rejects longer objectives before sending", async () => {
	const objective = "🐈".repeat(4096);
	const { requests, results } = await runKeyedExa([
		["at limit", { objective }],
		["over limit", { objective: "x".repeat(4097) }],
		["empty", { objective: "" }],
	]);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].body.objective, objective);
	assert.equal(requests[1].body.objective, "");
	assert.match(results[1].error, /4096 characters or fewer/);
});

test("keyed Exa preserves a zero cost and omits absent cost", async () => {
	const { results } = await runKeyedExa([["zero cost"]], { total: 0 });
	assert.deepEqual(results[0].exaCostDollars, { total: 0 });
	const absent = await runKeyedExa([["unknown cost"]]);
	assert.equal(Object.hasOwn(absent.results[0], "exaCostDollars"), false);
});

test("Pi web_search forwards objective to Exa and returns its full cost in details", async () => {
	const objective = "Find documented limits for the upstream integration.";
	const costDollars = { total: 0.003, search: { neural: 0.003 } };
	const { requests, results } = await runKeyedExa([["Pi objective", { objective }]], costDollars, { tool: true });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].body.objective, objective);
	assert.ok(results[0].details, JSON.stringify(results[0]));
	assert.deepEqual(results[0].details.exaCostDollars, [{ query: "Pi objective", costDollars }]);
});
