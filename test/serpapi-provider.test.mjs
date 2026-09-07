import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const serpApiModuleUrl = new URL("../serpapi.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serpapi-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "SERPAPI_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY",
		"TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY",
		"JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "SERPER_API_KEY",
		"ANYSEARCH_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "BRIGHTDATA_API_KEY", "VALYU_API_KEY", "SEARXNG_BASE_URL", "EXA_API_KEY",
		"PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

test("SerpApi maps Google organic results, filters, recency, and environment credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url) => {
			captured = String(url);
			return new Response(JSON.stringify({ organic_results: [
				{ title: "Allowed", link: "https://docs.example.com/a", snippet: "result" },
				{ title: "Excluded", link: "https://private.docs.example.com/b", snippet: "private" },
				{ title: "Outside", link: "https://example.net/c", snippet: "outside" }
			] }), { status: 200 });
		};
		const { searchWithSerpApi } = await import(${JSON.stringify(serpApiModuleUrl)});
		const result = await searchWithSerpApi("google query", { numResults: 3, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week" });
		const url = new URL(captured);
		console.log(JSON.stringify({ params: Object.fromEntries(url.searchParams), result }));
	`, { PI_CODING_AGENT_DIR: home, SERPAPI_KEY: "serpapi-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.params.engine, "google");
	assert.equal(output.params.api_key, "serpapi-test-key");
	assert.equal(output.params.num, "8");
	assert.equal(output.params.tbs, "qdr:w");
	assert.match(output.params.q, /site:example\.com/);
	assert.match(output.params.q, /-site:private\.docs\.example\.com/);
	assert.deepEqual(output.result.results, [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }]);
});

test("SerpApi supports explicit routing but is excluded from provider all", async () => {
	const home = await createHome({ serpapiApiKey: "serpapi-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://serpapi.com/search.json?")) return new Response(JSON.stringify({ organic_results: [{ title: "SerpApi", link: "https://example.com", snippet: "result" }] }), { status: 200 });
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "serpapi" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({ explicitProvider: explicit.provider, allProviders: all.providerResponses.map(result => result.provider), calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.explicitProvider, "serpapi");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.calls.filter(url => url.startsWith("https://serpapi.com/search.json?")).length, 1);
});

test("SerpApi provider timeouts can fall through configured routing", async () => {
	const home = await createHome({
		serpapiApiKey: "serpapi-test-key",
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["serpapi", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://serpapi.com/search.json?")) {
				const error = new Error("The operation was aborted due to timeout");
				error.name = "TimeoutError";
				throw error;
			}
			if (target.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("timeout route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "brave");
	assert.ok(output.calls[0].startsWith("https://serpapi.com/search.json?"));
	assert.ok(output.calls[1].startsWith("https://api.search.brave.com/res/v1/web/search"));
});

test("SerpApi redacts API errors and appears in the Curator", async () => {
	const home = await createHome({ serpapiApiKey: "serpapi-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response("invalid serpapi-secret", { status: 401 });
		const { searchWithSerpApi } = await import(${JSON.stringify(serpApiModuleUrl)});
		try { await searchWithSerpApi("redact"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /\[redacted\]/);
	assert.doesNotMatch(output.error, /serpapi-secret/);

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, serpapi: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "serpapi", "serpapi", [], null);
	assert.match(page, /data-provider="serpapi"/);
	assert.match(page, />SerpApi<\/button>/);
	assert.match(page, /provider === "serpapi"\) return "SerpApi"/);
});
