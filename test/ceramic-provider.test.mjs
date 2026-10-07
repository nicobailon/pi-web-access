import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ceramicModuleUrl = new URL("../ceramic.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function withHome(config, run) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-ceramic-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
		return await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "CERAMIC_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY",
		"TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY",
		"JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SEARXNG_BASE_URL",
		"EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const envelope = (results) => JSON.stringify({ requestId: "r1", result: { results, searchMetadata: { executionTime: 0.1 }, totalResults: results.length } });

test("Ceramic posts the query with a Bearer key and maps nested results", () => withHome({ ceramicApiKey: "ceramic-key" }, (home) => {
	const output = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(envelope([
				{ title: " Paper ", url: "https://example.com/paper", description: "First line\n\n  second   line " + "x".repeat(800) },
				{ title: "Again", url: "https://example.com/paper", description: "duplicate" },
				{ title: "", url: "https://example.net/untitled", description: "" },
				{ title: "File", url: "file:///tmp/result", description: "skipped" },
			]))}, { status: 200 });
		};
		const { searchWithCeramic, isCeramicAvailable } = await import(${JSON.stringify(ceramicModuleUrl)});
		const result = await searchWithCeramic("node release", { numResults: 50, recencyFilter: "week" });
		console.log(JSON.stringify({ captured, available: isCeramicAvailable(), result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.available, true);
	assert.equal(output.captured.url, "https://api.ceramic.ai/search");
	assert.equal(output.captured.method, "POST");
	assert.equal(output.captured.headers.Authorization, "Bearer ceramic-key");
	// Ceramic has no date filter, so recency is not sent.
	assert.deepEqual(output.captured.body, { query: "node release", maxResults: 20, maxDescriptionLength: 1000 });
	const [paper, untitled, ...rest] = output.result.results;
	assert.equal(paper.title, "Paper");
	assert.equal(paper.snippet.length, 500);
	assert.ok(paper.snippet.startsWith("First line second line x"));
	assert.deepEqual(untitled, { title: "Source 2", url: "https://example.net/untitled", snippet: "" });
	assert.deepEqual(rest, []);
	assert.match(output.result.answer, /Source: Paper \(https:\/\/example\.com\/paper\)/);
}));

test("Ceramic needs a key, and CERAMIC_API_KEY takes precedence over the config value", async () => {
	await withHome({}, (home) => {
		const output = runChild(`
			globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
			const { searchWithCeramic, isCeramicAvailable } = await import(${JSON.stringify(ceramicModuleUrl)});
			let error;
			try { await searchWithCeramic("q"); } catch (err) { error = String(err); }
			console.log(JSON.stringify({ available: isCeramicAvailable(), error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(output.available, false);
		assert.match(output.error, /Ceramic API key not found/);
		assert.match(output.error, /CERAMIC_API_KEY/);
	});
	await withHome({ ceramicApiKey: "config-key" }, (home) => {
		const output = runChild(`
			let authorization;
			globalThis.fetch = async (_url, init) => { authorization = init.headers.Authorization; return new Response(${JSON.stringify(envelope([]))}); };
			const { searchWithCeramic } = await import(${JSON.stringify(ceramicModuleUrl)});
			const result = await searchWithCeramic("q");
			console.log(JSON.stringify({ authorization, results: result.results }));
		`, { PI_CODING_AGENT_DIR: home, CERAMIC_API_KEY: "env-key" });
		assert.equal(output.authorization, "Bearer env-key");
		assert.deepEqual(output.results, []);
	});
});

test("Ceramic sends allowed domains as site: clauses and filters excluded domains locally", () => withHome({ ceramicApiKey: "k" }, (home) => {
	const output = runChild(`
		const bodies = [];
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return new Response(${JSON.stringify(envelope([
				{ title: "Allowed", url: "https://docs.example.com/a", description: "a" },
				{ title: "Excluded", url: "https://private.docs.example.com/b", description: "b" },
				{ title: "Outside", url: "https://example.net/c", description: "c" },
				{ title: "Other allowed", url: "https://example.org/d", description: "d" },
			]))});
		};
		const { searchWithCeramic } = await import(${JSON.stringify(ceramicModuleUrl)});
		const single = await searchWithCeramic("single", { domainFilter: ["https://example.com/"], numResults: 3 });
		const several = await searchWithCeramic("several", { domainFilter: ["example.com", "example.org", "-private.docs.example.com"], numResults: 3 });
		console.log(JSON.stringify({ bodies, single: single.results.map(r => r.url), several: several.results.map(r => r.url) }));
	`, { PI_CODING_AGENT_DIR: home });
	const [singleBody, severalBody] = output.bodies;
	assert.equal(singleBody.query, "single site:example.com");
	assert.equal(singleBody.maxResults, 8);
	assert.equal(severalBody.query, "several (site:example.com OR site:example.org)");
	assert.deepEqual(output.single, ["https://docs.example.com/a", "https://private.docs.example.com/b"]);
	assert.deepEqual(output.several, ["https://docs.example.com/a", "https://example.org/d"]);
}));

test("Ceramic is selectable explicitly but excluded from auto and provider all", () => withHome({ ceramicApiKey: "k" }, (home) => {
	const output = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.ceramic.ai/search") return new Response(${JSON.stringify(envelope([{ title: "Ceramic", url: "https://example.com", description: "result" }]))});
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "ceramic" });
		const auto = await search("auto", { provider: "auto" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({ explicitProvider: explicit.provider, autoProvider: auto.provider, allProviders: all.providerResponses.map(result => result.provider), calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.explicitProvider, "ceramic");
	assert.equal(output.autoProvider, "exa");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.calls.filter(url => url.startsWith("https://api.ceramic.ai/")).length, 1);
}));

test("Ceramic reports API errors redacted, rejects malformed envelopes, and appears in the Curator", async () => {
	await withHome({ ceramicApiKey: "ceramic-secret" }, (home) => {
		const errors = runChild(`
			const responses = [
				new Response(JSON.stringify({ title: "Unauthorized", status: 401, detail: "Invalid key ceramic-secret", requestId: "r", code: "unauthorized" }), { status: 401 }),
				new Response(JSON.stringify({ requestId: "r", result: {} }), { status: 200 }),
				new Response("not json", { status: 200 }),
			];
			globalThis.fetch = async () => responses.shift();
			const { searchWithCeramic } = await import(${JSON.stringify(ceramicModuleUrl)});
			const errors = [];
			for (let i = 0; i < 3; i++) {
				try { await searchWithCeramic("broken"); } catch (error) { errors.push(String(error)); }
			}
			console.log(JSON.stringify(errors));
		`, { PI_CODING_AGENT_DIR: home });
		const [auth, malformed, json] = errors;
		assert.match(auth, /Ceramic error 401: Unauthorized: Invalid key \[redacted\]/);
		assert.doesNotMatch(auth, /ceramic-secret/);
		assert.match(malformed, /Ceramic returned invalid response: expected result\.results array/);
		assert.match(json, /Ceramic returned invalid JSON/);
	});

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, ceramic: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "ceramic", "ceramic", [], null);
	assert.match(page, /data-provider="ceramic"/);
	assert.match(page, />Ceramic<\/button>/);
	assert.match(page, /provider === "ceramic"\) return "Ceramic"/);
});
