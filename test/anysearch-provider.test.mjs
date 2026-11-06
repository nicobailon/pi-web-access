import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const anysearchModuleUrl = new URL("../anysearch.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-anysearch-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "ANYSEARCH_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SEARXNG_BASE_URL", "EXA_API_KEY",
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

function successBody(content = "full page") {
	return JSON.stringify({ code: 0, data: { results: [{ title: "AnySearch result", url: "https://example.com/result", snippet: "A useful snippet", content }], metadata: {} } });
}

test("AnySearch supports anonymous success with a minimal request and gated content", async () => {
	const home = await createHome({});
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(successBody())}, { status: 200 });
		};
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		const withoutContent = await searchWithAnySearch("anonymous", { numResults: 3, recencyFilter: "week", domainFilter: ["example.com"] });
		const withContent = await searchWithAnySearch("anonymous", { includeContent: true });
		console.log(JSON.stringify({ captured, withoutContent, withContent }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.captured, {
		url: "https://api.anysearch.com/v1/search",
		method: "POST",
		headers: { "content-type": "application/json" },
		body: { query: "anonymous", max_results: 5 },
	});
	assert.equal(output.withoutContent.inlineContent, undefined);
	assert.deepEqual(output.withContent.inlineContent, [{ url: "https://example.com/result", title: "AnySearch result", content: "full page", error: null }]);
});

test("AnySearch accepts missing or null result content", async () => {
	const home = await createHome({});
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { results: [
			{ title: "Missing content", url: "https://example.com/missing", snippet: "missing" },
			{ title: "Null content", url: "https://example.com/null", snippet: "null", content: null },
			{ title: "Full content", url: "https://example.com/full", snippet: "full", content: "page body" },
		], metadata: {} } }), { status: 200 });
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		console.log(JSON.stringify(await searchWithAnySearch("partial content", { includeContent: true })));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.results.map(result => result.url), ["https://example.com/missing", "https://example.com/null", "https://example.com/full"]);
	assert.deepEqual(output.inlineContent, [{ url: "https://example.com/full", title: "Full content", content: "page body", error: null }]);
	const invalidChild = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { results: [
			{ title: "Invalid content", url: "https://example.com/invalid", snippet: "invalid", content: 123 },
		], metadata: {} } }), { status: 200 });
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		try { await searchWithAnySearch("invalid content"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(invalidChild.status, 0, invalidChild.stderr);
	assert.match(JSON.parse(invalidChild.stdout.trim()).error, /expected data\.results\[0\]\.content string/);
});

test("AnySearch sends keyed auth and resolves command credentials lazily", async () => {
	const marker = join(await mkdtemp(join(tmpdir(), "pi-web-access-anysearch-marker-")), "ran");
	const home = await createHome({ anysearchApiKey: `!touch ${marker} && printf anysearch-command-key` });
	const child = runChild(`
		import { existsSync } from "node:fs";
		let captured;
		globalThis.fetch = async (url, init) => { captured = Object.fromEntries(new Headers(init.headers)); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { isAnySearchAvailable, searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		const before = existsSync(${JSON.stringify(marker)});
		await searchWithAnySearch("keyed");
		console.log(JSON.stringify({ before, after: existsSync(${JSON.stringify(marker)}), captured }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		before: false,
		after: true,
		captured: { authorization: "Bearer anysearch-command-key", "content-type": "application/json" },
	});
});

test("explicit AnySearch provider routing works and is available anonymously", async () => {
	const home = await createHome({});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(${JSON.stringify(successBody("route content"))}, { status: 200 }); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "anysearch" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { provider: "anysearch", calls: ["https://api.anysearch.com/v1/search"] });
});

test("searchRouting accepts anonymous AnySearch availability and follows quota/transient fallback", async () => {
	const home = await createHome({ searchRouting: { providers: ["anysearch", "brave"], fallbackOn: ["quota", "transient"] } });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.anysearch.com/v1/search") return new Response("quota", { status: 402 });
			return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "brave-key" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "brave",
		calls: ["https://api.anysearch.com/v1/search", "https://api.search.brave.com/res/v1/web/search?q=route&count=5"],
	});
});

for (const [status, kind] of [[400, "invalid-request"], [401, "auth"], [403, "auth"], [402, "quota"], [429, "quota"], [500, "transient"], [503, "transient"], [504, "transient"]]) {
	test(`AnySearch HTTP ${status} is classified as ${kind}`, async () => {
		const home = await createHome({ searchRouting: { providers: ["anysearch", "brave"], fallbackOn: [kind === "auth" || kind === "invalid-request" ? "quota" : kind] } });
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				if (String(url) === "https://api.anysearch.com/v1/search") return new Response("provider failure", { status: ${status} });
				return new Response(JSON.stringify({ web: { results: [{ title: "fallback", url: "https://example.com/fallback", description: "ok" }] } }), { status: 200 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			try { const result = await search("classified", { provider: "auto" }); console.log(JSON.stringify({ ok: true, provider: result.provider, calls })); }
			catch (error) { console.log(JSON.stringify({ ok: false, error: String(error), calls })); }
		`, { PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "brave-key" });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		if (kind === "auth" || kind === "invalid-request") {
			assert.equal(output.ok, false);
			assert.match(output.error, new RegExp(`anysearch search failed \\(${kind}\\)`));
			assert.deepEqual(output.calls, ["https://api.anysearch.com/v1/search"]);
		} else {
			assert.equal(output.ok, true);
			assert.equal(output.provider, "brave");
			assert.equal(output.calls.length, 2);
		}
	});
}

test("AnySearch malformed envelopes fail loudly", async () => {
	const home = await createHome({});
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { results: [] } }), { status: 200 });
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		try { await searchWithAnySearch("malformed"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /AnySearch API returned invalid response: expected data\.metadata object/);
});

test("AnySearch malformed config root fails explicitly", async () => {
	const home = await createHome(null);
	const child = runChild(`
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		try { await searchWithAnySearch("malformed config"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /Invalid config in .*web-search\.json: expected a JSON object/);
});

test("AnySearch aborts without falling through", async () => {
	const home = await createHome({});
	const child = runChild(`
		globalThis.fetch = async (_url, init) => { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error("The operation was aborted"); };
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		try { await searchWithAnySearch("cancel", { signal: AbortSignal.abort() }); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /aborted/);
});

test("AnySearch is never part of auto fallback without explicit routing", async () => {
	const home = await createHome({});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("unexpected auto provider"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try { await search("auto", { provider: "auto" }); console.log(JSON.stringify({ ok: true, calls })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error), calls })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.ok(output.calls.every((url) => !url.startsWith("https://api.anysearch.com/")));
	assert.doesNotMatch(output.error, /AnySearch/);
});

test("AnySearch HTTP errors redact keyed credentials", async () => {
	const home = await createHome({ anysearchApiKey: "anysearch-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response("secret anysearch-secret", { status: 401 });
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		try { await searchWithAnySearch("redact"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.doesNotMatch(output.error, /anysearch-secret/);
	assert.match(output.error, /\[redacted\]/);
});

test("AnySearch clamps max_results to the API maximum of 10", async () => {
	const home = await createHome({});
	const child = runChild(`
		const bodies = [];
		globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		await searchWithAnySearch("clamp high", { numResults: 20 });
		await searchWithAnySearch("clamp very high", { numResults: 50 });
		await searchWithAnySearch("keep small", { numResults: 3 });
		await searchWithAnySearch("default count");
		console.log(JSON.stringify(bodies));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const bodies = JSON.parse(child.stdout.trim());
	assert.deepEqual(bodies.map(body => body.max_results), [10, 10, 3, 5]);
	assert.deepEqual(bodies.map(body => Object.keys(body).sort()), [["max_results", "query"], ["max_results", "query"], ["max_results", "query"], ["max_results", "query"]]);
});

test("AnySearch applies the shared domainFilter locally without adding request parameters", async () => {
	const home = await createHome({});
	const results = [
		{ title: "On domain", url: "https://example.com/on", snippet: "on", content: "on page" },
		{ title: "On subdomain", url: "https://news.example.com/sub", snippet: "sub", content: "sub page" },
		{ title: "Excluded blog", url: "https://blog.example.com/post", snippet: "blog", content: "blog page" },
		{ title: "Off domain", url: "https://other.org/page", snippet: "off", content: "off page" },
		{ title: "Unparseable", url: "example.com/no-scheme", snippet: "bad", content: "bad page" },
	];
	const child = runChild(`
		const bodies = [];
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ code: 0, data: { results: ${JSON.stringify(results)}, metadata: {} } }), { status: 200 });
		};
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		const included = await searchWithAnySearch("include", { domainFilter: ["example.com", "-blog.example.com"], includeContent: true });
		const excluded = await searchWithAnySearch("exclude", { domainFilter: ["-other.org"] });
		const nothing = await searchWithAnySearch("nothing", { domainFilter: ["nowhere.test"] });
		console.log(JSON.stringify({ bodies, included, excluded, nothing }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.bodies, [
		{ query: "include", max_results: 5 },
		{ query: "exclude", max_results: 5 },
		{ query: "nothing", max_results: 5 },
	]);
	assert.deepEqual(output.included.results.map(result => result.url), ["https://example.com/on", "https://news.example.com/sub"]);
	assert.deepEqual(output.included.inlineContent.map(entry => entry.url), ["https://example.com/on", "https://news.example.com/sub"]);
	assert.equal(output.included.answer, "on\nSource: On domain (https://example.com/on)\n\nsub\nSource: On subdomain (https://news.example.com/sub)");
	assert.deepEqual(output.excluded.results.map(result => result.url), ["https://example.com/on", "https://news.example.com/sub", "https://blog.example.com/post"]);
	assert.deepEqual(output.nothing.results, []);
	assert.equal(output.nothing.answer, "");
	assert.equal(output.nothing.inlineContent, undefined);
});

test("AnySearch filters before slicing to numResults", async () => {
	const home = await createHome({});
	const results = [
		{ title: "Off one", url: "https://one.test/a", snippet: "a" },
		{ title: "Off two", url: "https://two.test/b", snippet: "b" },
		{ title: "On one", url: "https://example.com/c", snippet: "c" },
		{ title: "On two", url: "https://example.com/d", snippet: "d" },
	];
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { results: ${JSON.stringify(results)}, metadata: {} } }), { status: 200 });
		const { searchWithAnySearch } = await import(${JSON.stringify(anysearchModuleUrl)});
		const result = await searchWithAnySearch("sliced", { domainFilter: ["example.com"], numResults: 1 });
		console.log(JSON.stringify(result));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.results.map(result => result.url), ["https://example.com/c"]);
});

test("a domainFilter that removes every AnySearch result feeds the existing domain-miss fallback", async () => {
	const results = JSON.stringify([{ title: "Off domain", url: "https://other.org/page", snippet: "off" }]);
	const script = (routing) => `
		globalThis.fetch = async (url) => {
			if (String(url) === "https://api.anysearch.com/v1/search") return new Response(JSON.stringify({ code: 0, data: { results: ${results}, metadata: {} } }), { status: 200 });
			return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("domain miss", { provider: "auto", domainFilter: ["example.com"] });
		console.log(JSON.stringify({ provider: result.provider, results: result.results.map(entry => entry.url) }));
	`;
	const optedIn = runChild(script(), { PI_CODING_AGENT_DIR: await createHome({ searchRouting: { providers: ["anysearch", "brave"], fallbackOn: ["domain-miss"] } }), BRAVE_API_KEY: "brave-key" });
	assert.equal(optedIn.status, 0, optedIn.stderr);
	assert.deepEqual(JSON.parse(optedIn.stdout.trim()), { provider: "brave", results: ["https://example.com/brave"] });

	const notOptedIn = runChild(script(), { PI_CODING_AGENT_DIR: await createHome({ searchRouting: { providers: ["anysearch", "brave"], fallbackOn: ["quota"] } }), BRAVE_API_KEY: "brave-key" });
	assert.equal(notOptedIn.status, 0, notOptedIn.stderr);
	assert.deepEqual(JSON.parse(notOptedIn.stdout.trim()), { provider: "anysearch", results: [] });
});
