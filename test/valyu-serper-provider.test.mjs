import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const valyuModuleUrl = new URL("../valyu.ts", import.meta.url).href;
const serperModuleUrl = new URL("../serper.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-valyu-serper-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "VALYU_API_KEY", "SERPER_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY",
		"FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY",
		"SERPBASE_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SEARXNG_BASE_URL", "EXA_API_KEY",
		"PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Valyu sends documented credentials, bounds returned content, and supports explicit routing", async () => {
	const home = await createHome({ valyuApiKey: "valyu-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
			return new Response(JSON.stringify({ success: true, results: [{
				title: "Valyu result", url: "https://example.com/valyu", description: "description", content: "x".repeat(5000), relevance_score: 1,
			}] }), { status: 200 });
		};
		const { searchWithValyu } = await import(${JSON.stringify(valyuModuleUrl)});
		const direct = await searchWithValyu("research", { numResults: 7, includeContent: true });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const routed = await search("route", { provider: "valyu" });
		console.log(JSON.stringify({ calls, direct, routedProvider: routed.provider }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls[0].url, "https://api.valyu.ai/v1/search");
	assert.equal(output.calls[0].headers["x-api-key"], "valyu-test-key");
	assert.deepEqual(output.calls[0].body, { query: "research", max_num_results: 7 });
	assert.equal(output.direct.results[0].snippet.length, 2500);
	assert.equal(output.direct.inlineContent[0].content.length, 4000);
	assert.equal(output.routedProvider, "valyu");
});

test("Serper maps organic results and reads its environment credential", async () => {
	const home = await createHome({});
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ organic: [{ title: "Serper result", link: "https://example.com/serper", snippet: "Google result", position: 1 }] }), { status: 200 });
		};
		const { searchWithSerper } = await import(${JSON.stringify(serperModuleUrl)});
		const result = await searchWithSerper("google query", { numResults: 4 });
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home, SERPER_API_KEY: "serper-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://google.serper.dev/search");
	assert.equal(output.captured.headers["x-api-key"], "serper-test-key");
	assert.deepEqual(output.captured.body, { q: "google query", num: 4 });
	assert.deepEqual(output.result.results, [{ title: "Serper result", url: "https://example.com/serper", snippet: "Google result" }]);
});

test("Curator page exposes usable Serper and Valyu provider entries", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = {
		all: false, openai: false, brave: false, parallel: false, tinyfish: false, search1api: false, searchinfinity: false,
		querit: false, tavily: false, firecrawl: false, jina: false, serpdive: false, kagi: false, bocha: false, ollama: false,
		searxng: false, duckduckgo: false, perplexity: false, exa: false, gemini: false, kimi: false, anysearch: false, xai: false,
		brightdata: false, serpbase: false, serper: true, valyu: true,
	};
	const page = generateCuratorPage(["query"], "session-token", 20, available, "serper", "valyu", [], null);
	assert.match(page, /data-provider="serper"/);
	assert.match(page, />Serper<\/button>/);
	assert.match(page, /data-provider="valyu"/);
	assert.match(page, />Valyu<\/button>/);
	assert.match(page, /"serpbase", "serper", "valyu"/);
});

test("Valyu maps domain and recency filters to documented request fields", async () => {
	const home = await createHome({ valyuApiKey: "valyu-test-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => {
			captured = JSON.parse(init.body);
			return new Response(JSON.stringify({ success: true, results: [] }), { status: 200 });
		};
		const { searchWithValyu } = await import(${JSON.stringify(valyuModuleUrl)});
		await searchWithValyu("research", { domainFilter: ["docs.example.com", "-private.example.com"], recencyFilter: "week" });
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.included_sources, ["docs.example.com"]);
	assert.deepEqual(output.excluded_sources, ["private.example.com"]);
	assert.match(output.start_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("Serper maps filters to Google parameters and reapplies domain filtering", async () => {
	const home = await createHome({ serperApiKey: "serper-test-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => {
			captured = JSON.parse(init.body);
			return new Response(JSON.stringify({ organic: [
				{ title: "Allowed", link: "https://docs.example.com/a", snippet: "allowed" },
				{ title: "Excluded", link: "https://private.docs.example.com/b", snippet: "excluded" },
				{ title: "Outside", link: "https://example.net/c", snippet: "outside" }
			] }), { status: 200 });
		};
		const { searchWithSerper } = await import(${JSON.stringify(serperModuleUrl)});
		const result = await searchWithSerper("docs", { numResults: 3, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week" });
		console.log(JSON.stringify({ captured, urls: result.results.map((result) => result.url) }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.captured.q, /site:example\.com/);
	assert.match(output.captured.q, /-site:private\.docs\.example\.com/);
	assert.equal(output.captured.tbs, "qdr:w");
	assert.equal(output.captured.num, 8);
	assert.deepEqual(output.urls, ["https://docs.example.com/a"]);
});

test("Valyu and Serper can be configured for routing but provider all never calls them", async () => {
	const home = await createHome({ searchRouting: { providers: ["valyu", "serper"], fallbackOn: ["quota"] } });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.valyu.ai/v1/search") return new Response("quota", { status: 429 });
			if (String(url) === "https://google.serper.dev/search") return new Response(JSON.stringify({ organic: [{ title: "Serper", link: "https://example.com", snippet: "fallback" }] }), { status: 200 });
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const routed = await search("route", { provider: "auto" });
		try { await search("all", { provider: "all" }); } catch (error) { var allError = String(error); }
		console.log(JSON.stringify({ calls, routedProvider: routed.provider, allError }));
	`, { PI_CODING_AGENT_DIR: home, VALYU_API_KEY: "valyu-key", SERPER_API_KEY: "serper-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls.slice(0, 2), ["https://api.valyu.ai/v1/search", "https://google.serper.dev/search"]);
	assert.equal(output.calls.slice(2).some((url) => url === "https://api.valyu.ai/v1/search" || url === "https://google.serper.dev/search"), false);
	assert.equal(output.routedProvider, "serper");
	assert.doesNotMatch(output.allError, /Valyu|Serper/);
});

for (const [name, moduleUrl, envName, configKey, functionName] of [
	["Valyu", valyuModuleUrl, "VALYU_API_KEY", "valyuApiKey", "searchWithValyu"],
	["Serper", serperModuleUrl, "SERPER_API_KEY", "serperApiKey", "searchWithSerper"],
]) {
	test(`${name} HTTP errors redact its credential`, async () => {
		const secret = `${name.toLowerCase()}-secret`;
		const home = await createHome({ [configKey]: secret });
		const child = runChild(`
			globalThis.fetch = async () => new Response("secret ${secret}", { status: 401 });
			const { ${functionName} } = await import(${JSON.stringify(moduleUrl)});
			try { await ${functionName}("redact"); console.log(JSON.stringify({ ok: true })); }
			catch (error) { console.log(JSON.stringify({ error: String(error) })); }
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.doesNotMatch(output.error, new RegExp(secret));
		assert.match(output.error, /\[redacted\]/);
	});
}
