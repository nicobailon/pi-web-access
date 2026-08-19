import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../parallel-mcp.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-parallel-mcp-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "PARALLEL_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY", "GEMINI_API_KEY", "SEARXNG_BASE_URL"]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

test("Parallel MCP searches anonymously, maps filters, and supports explicit routing", async () => {
	const home = await createHome({ searchRouting: { providers: ["parallel-mcp"], fallbackOn: ["network"] } });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [
				{ title: "Allowed", url: "https://docs.example.com/a", excerpts: ["Allowed excerpt"] },
				{ title: "Excluded", url: "https://private.docs.example.com/b", excerpts: ["Excluded excerpt"] },
				{ title: "Outside", url: "https://example.net/c", excerpts: ["Outside excerpt"] }
			] } } }), { status: 200 });
		};
		const { searchWithParallelMcp } = await import(${JSON.stringify(moduleUrl)});
		const direct = await searchWithParallelMcp("docs", { numResults: 2, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week", includeContent: true });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const routed = await search("route", { provider: "auto" });
		console.log(JSON.stringify({ calls, direct, routedProvider: routed.provider }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls[0].url, "https://search.parallel.ai/mcp");
	assert.equal(output.calls[0].headers.authorization, undefined);
	assert.equal(output.calls[0].body.params.name, "web_search");
	assert.match(output.calls[0].body.params.arguments.search_queries[0], /site:example\.com/);
	assert.match(output.calls[0].body.params.arguments.search_queries[0], /-site:private\.docs\.example\.com/);
	assert.match(output.calls[0].body.params.arguments.search_queries[0], /past week/);
	assert.deepEqual(output.direct.results.map(result => result.url), ["https://docs.example.com/a"]);
	assert.equal(output.direct.inlineContent[0].content, "Allowed excerpt");
	assert.equal(output.routedProvider, "parallel-mcp");
});

test("Parallel MCP maps text-block search results", async () => {
	const home = await createHome({});
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Text result\\nURL: https://example.com/text\\nText: Result from a text block" }] } }), { status: 200 });
		const { searchWithParallelMcp } = await import(${JSON.stringify(moduleUrl)});
		console.log(JSON.stringify(await searchWithParallelMcp("text")));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.results, [{ title: "Text result", url: "https://example.com/text", snippet: "Result from a text block" }]);
});

test("Parallel MCP sends optional Bearer auth and redacts it from errors", async () => {
	const secret = "parallel-mcp-secret";
	const home = await createHome({ parallelApiKey: secret });
	const child = runChild(`
		let authorization;
		globalThis.fetch = async (_url, init) => {
			authorization = new Headers(init.headers).get("authorization");
			return new Response("credential ${secret}", { status: 401 });
		};
		const { searchWithParallelMcp } = await import(${JSON.stringify(moduleUrl)});
		try { await searchWithParallelMcp("secret"); } catch (error) { console.log(JSON.stringify({ authorization, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.authorization, `Bearer ${secret}`);
	assert.doesNotMatch(output.error, new RegExp(secret));
	assert.match(output.error, /\[redacted\]/);
});

test("Parallel MCP web_fetch is available only through explicit hosted fetch routing", async () => {
	const enabledHome = await createHome({ fetchRouting: { providers: ["parallel-mcp"], allowRemoteHostedProviders: true } });
	const enabled = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push(String(url));
			if (String(url) === "https://search.parallel.ai/mcp") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { results: [{ url: "https://example.com/article", title: "Article", excerpts: [], full_content: "# Full article\\n\\nUseful content." }] } } }), { status: 200 });
			return new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/article");
		console.log(JSON.stringify({ calls, result }));
	`, { PI_CODING_AGENT_DIR: enabledHome });
	assert.equal(enabled.status, 0, enabled.stderr);
	const enabledOutput = JSON.parse(enabled.stdout.trim());
	assert.equal(enabledOutput.calls.includes("https://search.parallel.ai/mcp"), true);
	assert.equal(enabledOutput.result.content, "# Full article\n\nUseful content.");

	const disabledHome = await createHome({ fetchRouting: { providers: ["parallel-mcp"], allowRemoteHostedProviders: false } });
	const disabled = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } }); };
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/article");
		console.log(JSON.stringify({ calls, error: result.error }));
	`, { PI_CODING_AGENT_DIR: disabledHome });
	assert.equal(disabled.status, 0, disabled.stderr);
	const disabledOutput = JSON.parse(disabled.stdout.trim());
	assert.equal(disabledOutput.calls.includes("https://search.parallel.ai/mcp"), false);
	assert.match(disabledOutput.error, /Remote hosted fetch providers are disabled/);
});

test("Parallel MCP stays outside provider all and the default fetch route", async () => {
	const home = await createHome({});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("failure", { status: 500 }); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try { await search("all", { provider: "all" }); } catch {}
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		await extractContent("https://example.com/article");
		console.log(JSON.stringify(calls));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const calls = JSON.parse(child.stdout.trim());
	assert.equal(calls.includes("https://search.parallel.ai/mcp"), false);
});

test("Curator page exposes a usable Parallel MCP provider entry", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = {
		all: false, openai: false, brave: false, parallel: false, "parallel-mcp": true, tinyfish: false, search1api: false,
		searchinfinity: false, querit: false, tavily: false, firecrawl: false, jina: false, serpdive: false, kagi: false,
		bocha: false, ollama: false, searxng: false, duckduckgo: false, perplexity: false, exa: false, gemini: false, kimi: false,
		anysearch: false, xai: false, brightdata: false, serpbase: false, serper: false, valyu: false,
	};
	const page = generateCuratorPage(["query"], "session-token", 20, available, "parallel-mcp", "parallel-mcp", [], null);
	assert.match(page, /data-provider="parallel-mcp"/);
	assert.match(page, />Parallel MCP<\/button>/);
	assert.match(page, /"parallel", "parallel-mcp", "tinyfish"/);
});
