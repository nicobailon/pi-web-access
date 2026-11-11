import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const automModuleUrl = new URL("../autom.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-autom-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "AUTOM_API_KEY", "AUTOM_BASE_URL", "EXA_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY"]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

const ORGANIC = {
	organic_results: [
		{ position: 1, title: "Autom result", link: "https://example.com/autom", snippet: "Google result", domain: "example.com" },
		{ position: 2, title: "No link", link: "", snippet: "skipped" },
		{ position: 3, title: "  ", link: "https://docs.example.com/page", snippet: null },
		{ position: 4, title: "Other site", link: "https://other.org/page", snippet: "other" },
	],
};

test("Autom sends a GET with the key header, maps organic results and trims to numResults", async () => {
	const home = await createHome({});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body ?? null });
			return new Response(${JSON.stringify(JSON.stringify(ORGANIC))}, { status: 200 });
		};
		const { searchWithAutom, isAutomAvailable } = await import(${JSON.stringify(automModuleUrl)});
		const available = isAutomAvailable();
		const result = await searchWithAutom("google query", { numResults: 2 });
		console.log(JSON.stringify({ calls, result, available }));
	`, { PI_CODING_AGENT_DIR: home, AUTOM_API_KEY: "autom-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
	assert.equal(output.calls.length, 1);
	assert.equal(output.calls[0].method, "GET");
	assert.equal(output.calls[0].url, "https://api.autom.dev/v1/google/search?query=google+query");
	assert.equal(output.calls[0].headers["x-api-key"], "autom-test-key");
	assert.equal(output.calls[0].body, null);
	assert.ok(!output.calls[0].url.includes("autom-test-key"));
	assert.deepEqual(output.result.results, [
		{ title: "Autom result", url: "https://example.com/autom", snippet: "Google result" },
		{ title: "Source 2", url: "https://docs.example.com/page", snippet: "" },
	]);
	assert.match(output.result.answer, /Autom result/);
});

test("Autom sends domain filters as site: clauses, reapplies them locally and maps recency to tbs", async () => {
	const home = await createHome({ automApiKey: "config-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(${JSON.stringify(JSON.stringify(ORGANIC))}, { status: 200 });
		};
		const { searchWithAutom } = await import(${JSON.stringify(automModuleUrl)});
		const result = await searchWithAutom("docs", { domainFilter: ["example.com", "-other.org"], recencyFilter: "week" });
		console.log(JSON.stringify({ calls, result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	const sent = new URL(output.calls[0].url);
	assert.equal(sent.searchParams.get("query"), "docs site:example.com -site:other.org");
	assert.equal(sent.searchParams.get("tbs"), "qdr:w");
	assert.equal(output.calls[0].headers["x-api-key"], "config-key");
	assert.deepEqual(output.result.results.map(r => r.url), ["https://example.com/autom", "https://docs.example.com/page"]);
});

test("Autom uses automBaseUrl, routes by name, stays out of auto and reports API errors without the key", async () => {
	const home = await createHome({ automApiKey: "secret-autom-key", automBaseUrl: "https://gateway.example.com/autom" });
	const child = runChild(`
		const calls = [];
		let status = 200;
		globalThis.fetch = async (url, init) => {
			calls.push(String(url));
			if (status !== 200) return new Response(JSON.stringify({ error: "Invalid API Key secret-autom-key" }), { status });
			return new Response(JSON.stringify({ search_parameters: { q: "none" } }), { status: 200 });
		};
		const { search, ALL_SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS } = await import(${JSON.stringify(searchModuleUrl)});
		const routed = await search("route", { provider: "autom" });
		status = 401;
		let error = "";
		try { await search("route", { provider: "autom" }); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ calls, routed, error, inAll: ALL_SEARCH_PROVIDERS.includes("autom"), resolved: RESOLVED_SEARCH_PROVIDERS.includes("autom") }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls[0], "https://gateway.example.com/autom/v1/google/search?query=route");
	assert.equal(output.routed.provider, "autom");
	assert.deepEqual(output.routed.results, []);
	assert.equal(output.resolved, true);
	assert.equal(output.inAll, false);
	assert.match(output.error, /Autom API error 401/);
	assert.ok(!output.error.includes("secret-autom-key"));
});

test("Autom without a key is unavailable and explains how to configure it", async () => {
	const home = await createHome({});
	const child = runChild(`
		globalThis.fetch = async () => { throw new Error("no request expected"); };
		const { searchWithAutom, isAutomAvailable } = await import(${JSON.stringify(automModuleUrl)});
		let error = "";
		try { await searchWithAutom("query"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ available: isAutomAvailable(), error }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false);
	assert.match(output.error, /AUTOM_API_KEY/);
});

test("Autom reports a malformed body as invalid JSON without the key", async () => {
	const home = await createHome({ automApiKey: "secret-autom-key" });
	const child = runChild(`
		globalThis.fetch = async () => new Response("secret-autom-key is not json", { status: 200 });
		const { searchWithAutom } = await import(${JSON.stringify(automModuleUrl)});
		let error = "";
		try { await searchWithAutom("query"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /^Autom API returned invalid JSON/);
	assert.ok(!output.error.includes("secret-autom-key"));
});
