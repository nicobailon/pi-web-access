import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const docs = readFileSync(new URL("../docs/custom-providers.md", import.meta.url), "utf8");

// Recipes are read from the docs, so a recipe that stops matching its API's response shape fails here.
function recipe(id) {
	const section = docs.split(/^### /m).find((part) => part.startsWith(`${id}\n`));
	assert.ok(section, `docs/custom-providers.md has no recipe for ${id}`);
	return JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)[1]).customSearchProviders[id];
}

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-custom-search-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env, ...env };
	for (const key of ["EXA_API_KEY", "BRAVE_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"]) delete childEnv[key];
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 4 * 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const KEY = "custom-test-key";
const bearer = ["authorization", `Bearer ${KEY}`];

// Response bodies are the fixtures the built-in provider tests used.
const RECIPES = [
	{
		id: "serper", env: "SERPER_API_KEY", method: "POST", url: "https://google.serper.dev/search", header: ["x-api-key", KEY], body: { q: "test query", num: 5 },
		response: { organic: [{ title: "Serper result", link: "https://example.com/serper", snippet: "Google result", position: 1 }] },
		results: [{ title: "Serper result", url: "https://example.com/serper", snippet: "Google result" }],
	},
	{
		id: "serpapi", env: "SERPAPI_KEY", method: "GET", url: `https://serpapi.com/search.json?engine=google&q=test+query&num=5&api_key=${KEY}`,
		response: { organic_results: [{ title: "Allowed", link: "https://docs.example.com/a", snippet: "result" }] },
		results: [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }],
	},
	{
		id: "serply", env: "SERPLY_API_KEY", method: "GET", url: "https://api.serply.io/v1/search?q=test+query&num=5", header: ["x-api-key", KEY],
		response: { results: [{ title: "Allowed", link: "https://docs.example.com/a", description: "result" }] },
		results: [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }],
	},
	{
		id: "searchapi", env: "SEARCHAPI_API_KEY", method: "GET", url: "https://www.searchapi.io/api/v1/search?engine=google&q=test+query", header: bearer,
		response: { search_metadata: { status: "Success" }, organic_results: [{ position: 1, title: "Allowed", link: "https://docs.example.com/a", snippet: "result" }] },
		results: [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }],
	},
	{
		id: "serpbase", env: "SERPBASE_API_KEY", method: "GET", url: `https://api.serpbase.dev/google/search?q=test+query&num=5&api_key=${KEY}`,
		response: { organic_results: [{ title: "SerpBase result", link: "https://example.com/result", snippet: "Google snippet" }] },
		results: [{ title: "SerpBase result", url: "https://example.com/result", snippet: "Google snippet" }],
	},
	{
		id: "autom", env: "AUTOM_API_KEY", method: "GET", url: "https://api.autom.dev/v1/google/search?query=test+query", header: ["x-api-key", KEY],
		response: { organic_results: [
			{ position: 1, title: "Autom result", link: "https://example.com/autom", snippet: "Google result", domain: "example.com" },
			{ position: 2, title: "No link", link: "", snippet: "skipped" },
			{ position: 3, title: "  ", link: "https://docs.example.com/page", snippet: null },
			{ position: 4, title: "Other site", link: "https://other.org/page", snippet: "other" },
		] },
		results: [
			{ title: "Autom result", url: "https://example.com/autom", snippet: "Google result" },
			{ title: "Other site", url: "https://other.org/page", snippet: "other" },
		],
	},
	{
		id: "cloro", env: "CLORO_API_KEY", method: "POST", url: "https://api.cloro.dev/v1/monitor/google", header: bearer, body: { query: "test query", country: "US" },
		response: { success: true, result: { organicResults: [{ position: 1, title: "The 12 best rank tracker tools", link: "https://zapier.com/blog/best-rank-tracker/", snippet: "Semrush does just about everything." }] } },
		results: [{ title: "The 12 best rank tracker tools", url: "https://zapier.com/blog/best-rank-tracker/", snippet: "Semrush does just about everything." }],
	},
	{
		id: "xcrawl", env: "XCRAWL_API_KEY", method: "POST", url: "https://run.xcrawl.com/v1/serp", header: bearer, body: { engine: "google_search", q: "test query" },
		response: {
			search_metadata: { id: "01KMMKX1EC62VPCD7FW8YZ8QVS", status: "completed", total_time_taken: 2 },
			organic_results: [
				{ position: 1, title: "First result", link: "https://www.example.com/first", snippet: "First result snippet." },
				{ position: 2, title: null, link: "https://sub.other-domain.org/second", snippet: "Second result snippet with no title." },
			],
		},
		results: [{ title: "First result", url: "https://www.example.com/first", snippet: "First result snippet." }],
	},
	{
		id: "serpdive", env: "SERPDIVE_API_KEY", method: "POST", url: "https://api.serpdive.com/v1/search", header: bearer, body: { query: "test query", model: "krill", max_results: 10 },
		response: { query: "test query", model: "krill", results: [
			{ url: "https://github.com/nicobailon/pi-web-access", title: "Repo", content: "repo content" },
			{ url: "https://gist.github.com/nicobailon/abc", title: "Gist", content: "gist content" },
		] },
		results: [
			{ title: "Repo", url: "https://github.com/nicobailon/pi-web-access", snippet: "repo content" },
			{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", snippet: "gist content" },
		],
	},
	{
		id: "search1api", env: "SEARCH1API_KEY", method: "POST", url: "https://api.search1api.com/search", header: bearer, body: { query: "test query", max_results: 5, crawl_results: 0 },
		response: { searchParameters: { query: "test query" }, results: [{ title: "Search1API Docs", link: "https://www.search1api.com/docs", snippet: "  Search, crawl, and extract. ", content: "# Full docs" }] },
		results: [{ title: "Search1API Docs", url: "https://www.search1api.com/docs", snippet: "Search, crawl, and extract." }],
	},
	{
		id: "outcrawl", env: "OUTCRAWL_API_KEY", method: "POST", url: "https://api.outcrawl.ai/v1/search", header: bearer, body: { query: "test query", limit: 5 },
		response: { hits: [{ rank: 1, title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }], usage: { credits: "0.5" } },
		results: [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }],
	},
	{
		id: "sofya", env: "SOFYA_API_KEY", method: "POST", url: "https://sofya.co/v1/search", header: bearer, body: { query: "test query", search_depth: "snippets", max_results: 5 },
		response: { query: "q", results: [{ rank: 1, title: "Allowed", url: "https://docs.example.com/a", content: "result" }], credits_used: 1 },
		results: [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }],
	},
	{
		id: "specstream", env: "SPECSTREAM_API_KEY", method: "GET", url: "https://api.specstream.ai/v1/web-search?q=test+query", header: bearer,
		response: { request_id: "r1", status: 200, data: { query: "q", sources: [
			{ url: "https://docs.example.com/a", title: "Allowed", site: "docs.example.com", snippet: "result" },
			{ url: "ftp://docs.example.com/d", title: "Not http", snippet: "ftp" },
		] }, error: null },
		results: [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }],
	},
];

// Each recipe is registered under the removed built-in's name, which is how a user migrates.
test("each documented recipe works under its old provider name and maps that provider's response", async () => {
	const home = await createHome({ customSearchProviders: Object.fromEntries(RECIPES.map(({ id }) => [id, recipe(id)])) });
	const env = Object.fromEntries(RECIPES.map(({ env }) => [env, KEY]));
	const output = runChild(`
		const recipes = ${JSON.stringify(RECIPES.map(({ id, response }) => ({ name: id, response })))};
		let current;
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body === undefined ? undefined : JSON.parse(init.body) });
			return new Response(JSON.stringify(current.response), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const outputs = [];
		for (const entry of recipes) {
			current = entry;
			const result = await search("test query", { provider: entry.name });
			outputs.push({ provider: result.provider, results: result.results, call: calls.at(-1) });
		}
		console.log(JSON.stringify(outputs));
	`, { PI_CODING_AGENT_DIR: home, ...env });
	RECIPES.forEach((expected, index) => {
		const { provider, results, call } = output[index];
		assert.equal(provider, expected.id);
		assert.equal(call.method, expected.method, expected.id);
		assert.equal(call.url, expected.url, expected.id);
		if (expected.header) assert.equal(call.headers[expected.header[0]], expected.header[1], expected.id);
		assert.deepEqual(call.body, expected.body, expected.id);
		assert.deepEqual(results, expected.results, expected.id);
	});
});

// Before the removal, an unknown name in the config `provider` string quietly became `auto`.
test("a removed provider named in config fails with a link to its recipe instead of searching elsewhere", async () => {
	const home = await createHome({ provider: "serper" });
	const output = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("Unexpected fetch " + url); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("q");
			console.log(JSON.stringify({ error: null, calls }));
		} catch (err) {
			console.log(JSON.stringify({ error: err.message, calls }));
		}
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(output.error, /serper was removed as a built-in provider\. Add it as a custom provider: see https:\/\/github\.com\/nicobailon\/pi-web-access\/blob\/main\/docs\/custom-providers\.md#serper/);
	assert.deepEqual(output.calls, []);
});

test("a response without the results path means no results; a non-array there is an error", async () => {
	const home = await createHome({ customSearchProviders: { mysearch: { url: "https://api.example.com/search/", results: "organic_results", fields: { title: "title", url: "link" } } } });
	const output = runChild(`
		const urls = [];
		const bodies = [{ search_parameters: { q: "none" } }, { organic_results: "oops" }];
		globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(JSON.stringify(bodies[urls.length - 1]), { status: 200 }); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const empty = await search("q", { provider: "mysearch" });
		let error = null;
		try { await search("q", { provider: "mysearch" }); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ urls, results: empty.results, error }));
	`, { PI_CODING_AGENT_DIR: home });
	// The configured URL is sent as written, trailing slash included.
	assert.equal(output.urls[0], "https://api.example.com/search/");
	assert.deepEqual(output.results, []);
	assert.match(output.error, /mysearch API returned invalid response: expected an array at "organic_results"/);
});

test("a dropped connection while reading the body falls back like a network error, and headers are not duplicated", async () => {
	const entry = (host) => ({ url: `https://${host}.example.com/search`, method: "POST", headers: { "content-type": "application/json" }, body: { q: "{query}" }, results: "items", fields: { title: "title", url: "link" } });
	const home = await createHome({
		customSearchProviders: { first: entry("first"), second: entry("second") },
		searchRouting: { providers: ["first", "second"], fallbackOn: ["network"] },
	});
	const output = runChild(`
		const contentTypes = [];
		globalThis.fetch = async (url, init = {}) => {
			contentTypes.push(new Headers(init.headers).get("content-type"));
			if (String(url).startsWith("https://first.")) return { ok: true, status: 200, json: async () => { throw new TypeError("terminated"); } };
			return new Response(JSON.stringify({ items: [{ title: "Second", link: "https://example.com/second" }] }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("q");
		console.log(JSON.stringify({ provider: result.provider, contentTypes }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.provider, "second");
	assert.deepEqual(output.contentTypes, ["application/json", "application/json"]);
});

test("a custom provider cannot take a built-in provider's name", async () => {
	const home = await createHome({ customSearchProviders: { brave: recipe("serper") } });
	const output = runChild(`
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("q", { provider: "brave" });
			console.log(JSON.stringify({ error: null }));
		} catch (err) {
			console.log(JSON.stringify({ error: err.message }));
		}
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(output.error, /customSearchProviders\.brave .*"brave" is already a built-in provider name/);
});

test("auto and all never use a custom provider", async () => {
	const home = await createHome({ customSearchProviders: { mysearch: recipe("serper") } });
	const output = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const auto = await search("q", { provider: "auto" });
		const all = await search("q", { provider: "all" });
		console.log(JSON.stringify({ auto: auto.provider, all: all.providerResponses.map((response) => response.provider), calls }));
	`, { PI_CODING_AGENT_DIR: home, SERPER_API_KEY: KEY });
	assert.equal(output.auto, "exa");
	assert.deepEqual(output.all, ["exa"]);
	assert.ok(output.calls.every((url) => !url.startsWith("https://google.serper.dev")), output.calls.join("\n"));
});

test("the MCP server accepts a custom provider name", async () => {
	const home = await createHome({ customSearchProviders: { mysearch: recipe("serper") } });
	const output = runChild(`
		const { MCP_TOOL_DEFINITIONS, validateMcpToolArguments } = await import(${JSON.stringify(new URL("../mcp-tool-definitions.ts", import.meta.url).href)});
		const tool = MCP_TOOL_DEFINITIONS.find((t) => t.name === "web_search");
		console.log(JSON.stringify({
			custom: validateMcpToolArguments(tool, { query: "q", provider: ["mysearch", "brave"] }),
			unknown: validateMcpToolArguments(tool, { query: "q", provider: "nosuch" }),
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(output.custom, []);
	assert.match(output.unknown[0], /unknown provider "nosuch".* Custom: mysearch\./);
});

test("a custom provider's key never appears in its error", async () => {
	const home = await createHome({ customSearchProviders: { mysearch: recipe("serpapi") } });
	const output = runChild(`
		globalThis.fetch = async (url) => new Response("invalid key " + new URL(url).searchParams.get("api_key"), { status: 401 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("q", { provider: "mysearch" });
		} catch (err) {
			console.log(JSON.stringify({ error: err.message }));
		}
	`, { PI_CODING_AGENT_DIR: home, SERPAPI_KEY: KEY });
	assert.match(output.error, /mysearch API error 401: invalid key \[redacted\]/);
	assert.ok(!output.error.includes(KEY));
});

test("an invalid header value is reported without the key", async () => {
	const home = await createHome({ customSearchProviders: { mysearch: { ...recipe("searchapi"), apiKeyPrefix: "Bearer \n" } } });
	const output = runChild(`
		globalThis.fetch = async () => { throw new Error("fetch should not run"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("q", { provider: "mysearch" });
		} catch (err) {
			console.log(JSON.stringify({ error: err.message }));
		}
	`, { PI_CODING_AGENT_DIR: home, SEARCHAPI_API_KEY: KEY });
	assert.ok(output.error);
	assert.ok(!output.error.includes(KEY), output.error);
});
