import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const youModuleUrl = new URL("../you.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const YOU_URL = "https://ydc-index.io/v1/search";

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-you-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "YDC_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY"]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

test("You.com sends the documented search request and maps web results", async () => {
	const home = await createHome();
	const child = runChild(`
		let request;
		globalThis.fetch = async (url, init) => {
			request = { url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ results: { web: [
				{ title: "Docs", url: "https://docs.example.com/a", description: "described" },
				{ title: "Snippet only", url: "https://example.com/b", snippets: ["first snippet"] },
				{ title: "Not a link", url: "not-a-url" },
				{ title: "Script", url: "javascript:alert(1)" }
			] } }), { status: 200 });
		};
		const { searchWithYou } = await import(${JSON.stringify(youModuleUrl)});
		const result = await searchWithYou("you query", { numResults: 3, recencyFilter: "week", domainFilter: ["example.com", "-private.example.com"] });
		console.log(JSON.stringify({ request, results: result.results }));
	`, { PI_CODING_AGENT_DIR: home, YDC_API_KEY: "you-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.request.url, YOU_URL);
	assert.equal(output.request.method, "POST");
	assert.equal(output.request.headers["X-API-Key"], "you-test-key");
	assert.deepEqual(output.request.body, {
		query: "you query",
		count: 3,
		freshness: "week",
		include_domains: ["example.com"],
		exclude_domains: ["private.example.com"],
	});
	assert.deepEqual(output.results, [
		{ title: "Docs", url: "https://docs.example.com/a", snippet: "described" },
		{ title: "Snippet only", url: "https://example.com/b", snippet: "first snippet" },
	]);
	await rm(home, { recursive: true, force: true });
});

test("You.com is explicit-only and routing skips it when no key is configured", async () => {
	const configured = await createHome({ youApiKey: "you-test-key" });
	const explicitOnly = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === ${JSON.stringify(YOU_URL)}) return new Response(JSON.stringify({ results: { web: [{ title: "You", url: "https://example.com" }] } }), { status: 200 });
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "you" });
		const auto = await search("auto", { provider: "auto" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({ explicit: explicit.provider, auto: auto.provider, all: all.providerResponses.map(result => result.provider), youCalls: calls.filter(url => url === ${JSON.stringify(YOU_URL)}).length }));
	`, { PI_CODING_AGENT_DIR: configured });
	assert.equal(explicitOnly.status, 0, explicitOnly.stderr);
	assert.deepEqual(JSON.parse(explicitOnly.stdout.trim()), { explicit: "you", auto: "exa", all: ["exa"], youCalls: 1 });
	await rm(configured, { recursive: true, force: true });

	const unconfigured = await createHome({ braveApiKey: "brave-test-key", searchRouting: { providers: ["you", "brave"], fallbackOn: ["network"] } });
	const routed = runChild(`
		globalThis.fetch = async (url) => {
			const target = String(url);
			if (target.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "routed" }] } }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		console.log(JSON.stringify({ provider: (await search("routed", { provider: "auto" })).provider }));
	`, { PI_CODING_AGENT_DIR: unconfigured });
	assert.equal(routed.status, 0, routed.stderr);
	assert.equal(JSON.parse(routed.stdout.trim()).provider, "brave");
	await rm(unconfigured, { recursive: true, force: true });
});

test("You.com redacts API errors and appears in the Curator", async () => {
	const home = await createHome({ youApiKey: "you-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response("invalid you-secret", { status: 401 });
		const { searchWithYou } = await import(${JSON.stringify(youModuleUrl)});
		try { await searchWithYou("redact"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /You\.com error 401/);
	assert.doesNotMatch(output.error, /you-secret/);

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, you: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "you", "you", [], null);
	assert.match(page, /data-provider="you"/);
	assert.match(page, />You\.com<\/button>/);
	assert.match(page, /provider === "you"\) return "You\.com"/);
	await rm(home, { recursive: true, force: true });
});
