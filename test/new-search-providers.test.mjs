import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const kagiModuleUrl = new URL("../kagi.ts", import.meta.url).href;
const bochaModuleUrl = new URL("../bocha.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const ollamaModuleUrl = new URL("../ollama.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const serpbaseModuleUrl = new URL("../serpbase.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-new-providers-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY",
		"TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY",
		"FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "ANYSEARCH_API_KEY",
		"XAI_API_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SEARXNG_BASE_URL", "EXA_API_KEY",
		"PERPLEXITY_API_KEY", "GEMINI_API_KEY", "CLOUDFLARE_API_KEY", "GOOGLE_GEMINI_BASE_URL",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

const publicLookup = `async () => [{ address: "93.184.216.34", family: 4 }]`;

test("Ollama search and Web Fetch use the Cloud REST endpoints", async () => {
	const home = await createHome({ ollamaApiKey: "ollama-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers)), body: init.body ? JSON.parse(init.body) : null });
			if (String(url) === "https://ollama.com/api/web_search") {
				return new Response(JSON.stringify({ results: [{ title: "Ollama result", url: "https://example.com/ollama", content: "Ollama snippet" }] }), { status: 200 });
			}
			if (String(url) === "https://ollama.com/api/web_fetch") {
				return new Response(JSON.stringify({ title: "Fetched", content: "Fetched markdown", links: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { searchWithOllama, extractWithOllama } = await import(${JSON.stringify(ollamaModuleUrl)});
		const search = await searchWithOllama("cloud search", { numResults: 7, includeContent: true });
		const fetched = await extractWithOllama("https://example.com/ollama", undefined, { lookup: ${publicLookup} });
		console.log(JSON.stringify({ calls, search, fetched }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls[0].url, "https://ollama.com/api/web_search");
	assert.equal(output.calls[0].headers.authorization, "Bearer ollama-test-key");
	assert.deepEqual(output.calls[0].body, { query: "cloud search", max_results: 7 });
	assert.deepEqual(output.search.inlineContent, [{ url: "https://example.com/ollama", title: "Ollama result", content: "Ollama snippet", error: null }]);
	assert.equal(output.calls[1].url, "https://ollama.com/api/web_fetch");
	assert.deepEqual(output.calls[1].body, { url: "https://example.com/ollama" });
	assert.equal(output.fetched.content, "Fetched markdown");
});

test("Kagi search maps v1 results and Extract maps markdown", async () => {
	const home = await createHome({ kagiApiKey: "kagi-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers)), body: init.body ? JSON.parse(init.body) : null });
			if (String(url) === "https://kagi.com/api/v1/search") {
				return new Response(JSON.stringify({ data: { search: [{ title: "Kagi result", url: "https://example.com/kagi", snippet: "Kagi snippet" }] } }), { status: 200 });
			}
			if (String(url) === "https://kagi.com/api/v1/extract") {
				return new Response(JSON.stringify({ data: [{ url: "https://example.com/kagi", title: "Kagi extract", markdown: "Kagi markdown" }] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { searchWithKagi, extractWithKagi } = await import(${JSON.stringify(kagiModuleUrl)});
		const search = await searchWithKagi("premium search", { numResults: 3, includeContent: true });
		const fetched = await extractWithKagi("https://example.com/kagi", undefined, { lookup: ${publicLookup} });
		console.log(JSON.stringify({ calls, search, fetched }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls[0].url, "https://kagi.com/api/v1/search");
	assert.equal(output.calls[0].method, "POST");
	assert.equal(output.calls[0].headers.authorization, "Bearer kagi-test-key");
	assert.deepEqual(output.calls[0].body, { query: "premium search", limit: 3 });
	assert.deepEqual(output.search.results, [{ title: "Kagi result", url: "https://example.com/kagi", snippet: "Kagi snippet" }]);
	assert.equal(output.calls[1].url, "https://kagi.com/api/v1/extract");
	assert.deepEqual(output.calls[1].body, { pages: [{ url: "https://example.com/kagi" }] });
	assert.equal(output.fetched.content, "Kagi markdown");
});

test("SerpBase is explicit-only and maps Google organic results", async () => {
	const home = await createHome({ serpbaseApiKey: "serpbase-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.serpbase.dev/google/search?")) {
				return new Response(JSON.stringify({ organic_results: [{ title: "SerpBase result", link: "https://example.com/result", snippet: "Google snippet" }] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { searchWithSerpBase } = await import(${JSON.stringify(serpbaseModuleUrl)});
		const direct = await searchWithSerpBase("google query", { numResults: 4, recencyFilter: "week", domainFilter: ["example.com"] });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try { await search("auto must not spend", { provider: "auto" }); }
		catch (error) { var autoError = String(error); }
		console.log(JSON.stringify({ calls, direct, autoError }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	const url = new URL(output.calls[0]);
	assert.equal(url.origin + url.pathname, "https://api.serpbase.dev/google/search");
	assert.equal(url.searchParams.get("api_key"), "serpbase-test-key");
	assert.equal(url.searchParams.get("num"), "4");
	assert.equal(url.searchParams.get("tbs"), "qdr:w");
	assert.match(url.searchParams.get("q"), /site:example\.com/);
	assert.deepEqual(output.direct.results, [{ title: "SerpBase result", url: "https://example.com/result", snippet: "Google snippet" }]);
	assert.equal(output.calls.filter(call => call.startsWith("https://api.serpbase.dev/google/search?")).length, 1);
	assert.doesNotMatch(output.autoError, /SerpBase/);
});

test("Bocha search filters domains and closes activity on API errors", async () => {
	const home = await createHome({ bochaApiKey: "bocha-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers)), body: init.body ? JSON.parse(init.body) : null });
			if (String(url) === "https://api.bochaai.com/v1/web-search" && calls.length === 1) {
				return new Response(JSON.stringify({ code: 200, data: { webPages: { value: [
					{ name: "Bocha result", url: "https://docs.example.com/bocha", summary: "Bocha snippet" },
					{ name: "Blocked result", url: "https://private.docs.example.com/bocha", summary: "Blocked snippet" },
					{ name: "Outside result", url: "https://outside.example.net/bocha", summary: "Outside snippet" },
				] } } }), { status: 200 });
			}
			if (String(url) === "https://api.bochaai.com/v1/web-search" && calls.length === 2) {
				return new Response(JSON.stringify({ code: 500, msg: "invalid request bocha-test-key" }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { searchWithBocha } = await import(${JSON.stringify(bochaModuleUrl)});
		const { activityMonitor } = await import(new URL("../activity.ts", ${JSON.stringify(import.meta.url)}).href);
		const search = await searchWithBocha("bocha query", { numResults: 5, recencyFilter: "week", domainFilter: ["example.com", "-private.docs.example.com"] });
		let errorText = "";
		try { await searchWithBocha("bad query"); } catch (error) { errorText = String(error); }
		console.log(JSON.stringify({ calls, search, errorText, errorActivity: activityMonitor.getEntries().at(-1) }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls[0].url, "https://api.bochaai.com/v1/web-search");
	assert.equal(output.calls[0].method, "POST");
	assert.equal(output.calls[0].headers.authorization, "Bearer bocha-test-key");
	assert.deepEqual(output.calls[0].body, { query: "bocha query", count: 5, freshness: "oneWeek", summary: true });
	assert.deepEqual(output.search.results, [{ title: "Bocha result", url: "https://docs.example.com/bocha", snippet: "Bocha snippet" }]);
	assert.match(output.errorText, /code 500/);
	assert.doesNotMatch(output.errorText, /bocha-test-key/);
	assert.equal(output.errorActivity.status, null);
	assert.equal(typeof output.errorActivity.endTime, "number");
	assert.match(output.errorActivity.error, /code 500/);
	assert.doesNotMatch(output.errorActivity.error, /bocha-test-key/);
});

test("Curator page exposes Bocha as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["bocha query"],
		"session-token",
		20,
		{
			all: false, openai: false, brave: false, parallel: false, tinyfish: false, search1api: false,
			searchinfinity: false, querit: false, tavily: false, jina: false, serpdive: false, kagi: false,
			bocha: true, ollama: false, searxng: false, duckduckgo: false, perplexity: false, exa: false,
			gemini: false, kimi: false, anysearch: false, xai: false, brightdata: false, serpbase: false,
		},
		"bocha",
		"bocha",
		[],
		null,
	);
	assert.match(page, /data-provider="bocha"/);
	assert.match(page, />Bocha<\/button>/);
	assert.match(page, /"bocha"/);
	assert.match(page, /provider === "bocha"\) return "Bocha"/);
});
