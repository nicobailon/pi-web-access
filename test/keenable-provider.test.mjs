import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const keenableModuleUrl = new URL("../keenable.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-keenable-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "KEENABLE_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY",
		"TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY",
		"JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "SERPAPI_KEY",
		"SERPER_API_KEY", "SERPLY_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "BRIGHTDATA_API_KEY",
		"VALYU_API_KEY", "SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

test("Keenable searches the public endpoint without a key and maps snippets", async () => {
	const home = await createHome();
	try {
		const child = runChild(`
			let captured;
			globalThis.fetch = async (url, init) => {
				captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
				return new Response(JSON.stringify({ query: "q", mode: "pro", results: [
					{ title: " Paper ", url: "https://example.com/paper", description: "", snippet: "First line\\n\\n  second   line " + "x".repeat(800), acquired_at: "2026-10-01T00:00:00Z" },
					{ title: "Fallback", url: "https://example.org/fallback", description: "Only a description", snippet: "" },
					{ title: "", url: "https://example.net/untitled", description: "", snippet: "" },
					{ title: "Both", url: "https://example.edu/both", description: "Short description", snippet: "Page text" }
				] }), { status: 200 });
			};
			const { searchWithKeenable, isKeenableAvailable } = await import(${JSON.stringify(keenableModuleUrl)});
			const result = await searchWithKeenable("keyless query");
			console.log(JSON.stringify({ captured, available: isKeenableAvailable(), result }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.available, true);
		assert.equal(output.captured.url, "https://api.keenable.ai/v1/search/public");
		assert.equal(output.captured.method, "POST");
		assert.equal(output.captured.headers["X-Keenable-Title"], "pi-web-access");
		assert.equal(output.captured.headers["X-API-Key"], undefined);
		assert.deepEqual(output.captured.body, { query: "keyless query", max_results: 5, snippet_max_length: 500 });
		const [paper, fallback, untitled, both] = output.result.results;
		assert.equal(both.snippet, "Page text");
		assert.equal(paper.title, "Paper");
		assert.equal(paper.snippet.length, 500);
		assert.ok(paper.snippet.startsWith("First line second line x"));
		assert.equal(fallback.snippet, "Only a description");
		assert.deepEqual(untitled, { title: "Source 3", url: "https://example.net/untitled", snippet: "" });
		assert.match(output.result.answer, /Source: Paper \(https:\/\/example\.com\/paper\)/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Keenable sends a configured or environment key to the authenticated endpoint", async () => {
	for (const [config, env, expected] of [
		[{ keenableApiKey: "config-key" }, {}, "config-key"],
		[{}, { KEENABLE_API_KEY: "env-key" }, "env-key"],
	]) {
		const home = await createHome(config);
		try {
			const child = runChild(`
				let captured;
				globalThis.fetch = async (url, init) => {
					captured = { url: String(url), headers: { ...init.headers } };
					return new Response(JSON.stringify({ results: [] }), { status: 200 });
				};
				const { searchWithKeenable } = await import(${JSON.stringify(keenableModuleUrl)});
				const result = await searchWithKeenable("keyed query");
				console.log(JSON.stringify({ captured, result }));
			`, { PI_CODING_AGENT_DIR: home, ...env });
			assert.equal(child.status, 0, child.stderr);
			const output = JSON.parse(child.stdout.trim());
			assert.equal(output.captured.url, "https://api.keenable.ai/v1/search");
			assert.equal(output.captured.headers["X-API-Key"], expected);
			assert.equal(output.captured.headers["X-Keenable-Title"], "pi-web-access");
			assert.deepEqual(output.result.results, []);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
});

test("Keenable maps one domain to site, others to query clauses, and recency to published_after", async () => {
	const home = await createHome();
	try {
		const child = runChild(`
			const bodies = [];
			globalThis.fetch = async (_url, init) => {
				bodies.push(JSON.parse(init.body));
				return new Response(JSON.stringify({ results: [
					{ title: "Allowed", url: "https://docs.example.com/a", snippet: "a" },
					{ title: "Duplicate", url: "https://docs.example.com/a", snippet: "again" },
					{ title: "Excluded", url: "https://private.docs.example.com/b", snippet: "b" },
					{ title: "Outside", url: "https://example.net/c", snippet: "c" },
					{ title: "Other allowed", url: "https://example.org/d", snippet: "d" },
					{ title: "Relative", url: "/relative", snippet: "e" },
					{ title: "File", url: "file:///tmp/result", snippet: "f" }
				] }), { status: 200 });
			};
			const { searchWithKeenable } = await import(${JSON.stringify(keenableModuleUrl)});
			const single = await searchWithKeenable("single", { domainFilter: ["https://example.com/"], recencyFilter: "week", numResults: 3 });
			const several = await searchWithKeenable("several", { domainFilter: ["example.com", "example.org", "-private.docs.example.com"], numResults: 3 });
			console.log(JSON.stringify({ bodies, single: single.results.map(r => r.url), several: several.results.map(r => r.url) }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		const [singleBody, severalBody] = output.bodies;
		assert.equal(singleBody.site, "example.com");
		assert.equal(singleBody.max_results, 3);
		assert.match(singleBody.published_after, /^\d{4}-\d{2}-\d{2}$/);
		const ageDays = (Date.now() - Date.parse(singleBody.published_after)) / 86_400_000;
		assert.ok(ageDays >= 7 && ageDays < 8, `published_after should be a week back, got ${singleBody.published_after}`);
		assert.equal(singleBody.query, "single");
		assert.equal(severalBody.site, undefined);
		assert.equal(severalBody.query, "several (site:example.com OR site:example.org) -site:private.docs.example.com");
		assert.equal(severalBody.max_results, 8);
		assert.equal(severalBody.published_after, undefined);
		assert.deepEqual(output.single, ["https://docs.example.com/a", "https://private.docs.example.com/b"]);
		assert.deepEqual(output.several, ["https://docs.example.com/a", "https://example.org/d"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Keenable supports explicit selection but is excluded from auto and provider all", async () => {
	const home = await createHome();
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target === "https://api.keenable.ai/v1/search/public") return new Response(JSON.stringify({ results: [{ title: "Keenable", url: "https://example.com", snippet: "result" }] }), { status: 200 });
				if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
				throw new Error("Unexpected fetch " + target);
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const explicit = await search("explicit", { provider: "keenable" });
			const auto = await search("auto", { provider: "auto" });
			const all = await search("all", { provider: "all" });
			console.log(JSON.stringify({ explicitProvider: explicit.provider, autoProvider: auto.provider, allProviders: all.providerResponses.map(result => result.provider), calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.explicitProvider, "keenable");
		assert.equal(output.autoProvider, "exa");
		assert.deepEqual(output.allProviders, ["exa"]);
		assert.equal(output.calls.filter(url => url.startsWith("https://api.keenable.ai/")).length, 1);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Keenable keyless rate limits name the key and fall through quota routing", async () => {
	const home = await createHome({
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["keenable", "brave"], fallbackOn: ["quota"] },
	});
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target === "https://api.keenable.ai/v1/search/public") {
					return new Response(JSON.stringify({ error: "Rate limit exceeded", message: "Public API hourly limit reached.", retryAfter: 60 }), { status: 429 });
				}
				if (target.startsWith("https://api.search.brave.com/res/v1/web/search")) {
					return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
				}
				throw new Error("Unexpected fetch " + target);
			};
			const { searchWithKeenable } = await import(${JSON.stringify(keenableModuleUrl)});
			let directError;
			try { await searchWithKeenable("limited"); } catch (error) { directError = String(error); }
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const routed = await search("limited", { provider: "auto" });
			console.log(JSON.stringify({ directError, provider: routed.provider, calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.match(output.directError, /Keenable error 429: .*hourly limit reached/);
		assert.match(output.directError, /set keenableApiKey or KEENABLE_API_KEY/);
		assert.equal(output.provider, "brave");
		assert.deepEqual(output.calls.map(url => new URL(url).hostname), ["api.keenable.ai", "api.keenable.ai", "api.search.brave.com"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Keenable strips the key on cross-origin redirects", async () => {
	const home = await createHome({ keenableApiKey: "keenable-test-key" });
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url, init) => {
				calls.push({ target: String(url), key: new Headers(init.headers).get("X-API-Key"), redirect: init.redirect });
				if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "/v1/search/moved" } });
				if (calls.length === 2) return new Response(null, { status: 307, headers: { location: "https://results.example/search" } });
				return new Response(JSON.stringify({ results: [] }));
			};
			const { searchWithKeenable } = await import(${JSON.stringify(keenableModuleUrl)});
			await searchWithKeenable("redirect");
			console.log(JSON.stringify(calls));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), [
			{ target: "https://api.keenable.ai/v1/search", key: "keenable-test-key", redirect: "manual" },
			{ target: "https://api.keenable.ai/v1/search/moved", key: "keenable-test-key", redirect: "manual" },
			{ target: "https://results.example/search", key: null, redirect: "manual" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Keenable rejects malformed envelopes, redacts API errors, and appears in the Curator", async () => {
	const home = await createHome({ keenableApiKey: "keenable-secret" });
	try {
		const child = runChild(`
			const responses = [
				new Response("invalid keenable-secret", { status: 401 }),
				new Response(JSON.stringify({ error: "nope" }), { status: 200 }),
				new Response("not json", { status: 200 }),
			];
			globalThis.fetch = async () => responses.shift();
			const { searchWithKeenable } = await import(${JSON.stringify(keenableModuleUrl)});
			const errors = [];
			for (let i = 0; i < 3; i++) {
				try { await searchWithKeenable("broken"); } catch (error) { errors.push(String(error)); }
			}
			console.log(JSON.stringify(errors));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const [auth, envelope, json] = JSON.parse(child.stdout.trim());
		assert.match(auth, /Keenable error 401: invalid \[redacted\]/);
		assert.doesNotMatch(auth, /keenable-secret/);
		assert.match(envelope, /Keenable returned invalid response: expected results array/);
		assert.match(json, /Keenable returned invalid JSON/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, keenable: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "keenable", "keenable", [], null);
	assert.match(page, /data-provider="keenable"/);
	assert.match(page, />Keenable<\/button>/);
	assert.match(page, /provider === "keenable"\) return "Keenable"/);
});
