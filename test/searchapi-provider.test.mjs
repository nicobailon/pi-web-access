import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchapiModuleUrl = new URL("../searchapi.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const SEARCH_URL = "https://www.searchapi.io/api/v1/search";

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-searchapi-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "SEARCHAPI_API_KEY", "SEARCHAPI_BASE_URL", "SERPLY_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY",
		"FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY",
		"SERPAPI_KEY", "SERPER_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "BRIGHTDATA_API_KEY", "VALYU_API_KEY",
		"SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

const organic = entries => JSON.stringify({ search_metadata: { status: "Success" }, organic_results: entries });

test("SearchApi maps Google results, filters, recency, and environment credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured;
		let capturedHeaders;
		globalThis.fetch = async (url, init) => {
			captured = String(url);
			capturedHeaders = { ...(init && init.headers) };
			return new Response(${JSON.stringify(organic([
				{ position: 1, title: "Allowed", link: "https://docs.example.com/a", snippet: "result" },
				{ position: 2, title: "Excluded", link: "https://private.docs.example.com/b", snippet: "private" },
				{ position: 3, title: "Outside", link: "https://example.net/c", snippet: "outside" },
			]))}, { status: 200 });
		};
		const { searchWithSearchApi } = await import(${JSON.stringify(searchapiModuleUrl)});
		const result = await searchWithSearchApi("google query", { numResults: 3, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week" });
		const url = new URL(captured);
		console.log(JSON.stringify({ origin: url.origin + url.pathname, params: Object.fromEntries(url.searchParams), headers: capturedHeaders, result }));
	`, { PI_CODING_AGENT_DIR: home, SEARCHAPI_API_KEY: "searchapi-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.origin, SEARCH_URL);
	assert.equal(output.headers.Authorization, "Bearer searchapi-test-key");
	assert.equal(output.headers["User-Agent"], "pi-web-access");
	assert.equal(output.params.api_key, undefined, "the key must travel in the header, never the query string");
	assert.equal(output.params.engine, "google");
	assert.equal(output.params.time_period, "last_week");
	assert.equal(output.params.num, undefined, "Google no longer honours num, so one results page is requested");
	assert.match(output.params.q, /^google query site:example\.com -site:private\.docs\.example\.com$/);
	assert.deepEqual(output.result.results, [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }]);
	await rm(home, { recursive: true, force: true });
});

test("SearchApi maps every recency filter to a documented time_period and omits it otherwise", async () => {
	const home = await createHome({ searchapiApiKey: "searchapi-test-key" });
	try {
		const child = runChild(`
			const periods = [];
			globalThis.fetch = async (url) => {
				periods.push(new URL(url).searchParams.get("time_period"));
				return new Response(${JSON.stringify(organic([{ title: "Result", link: "https://example.com/result", snippet: "" }]))});
			};
			const { searchWithSearchApi } = await import(${JSON.stringify(searchapiModuleUrl)});
			for (const recencyFilter of [undefined, "day", "week", "month", "year"]) await searchWithSearchApi("recency", { recencyFilter });
			console.log(JSON.stringify(periods));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), [null, "last_day", "last_week", "last_month", "last_year"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("SearchApi trims one results page to numResults and groups several allowed domains", async () => {
	const home = await createHome({ searchapiApiKey: "searchapi-test-key" });
	try {
		const child = runChild(`
			let query;
			globalThis.fetch = async (url) => {
				query = new URL(url).searchParams.get("q");
				return new Response(${JSON.stringify(organic(Array.from({ length: 10 }, (_, index) => ({ title: "Result " + index, link: "https://example.com/" + index, snippet: "" }))))});
			};
			const { searchWithSearchApi } = await import(${JSON.stringify(searchapiModuleUrl)});
			const result = await searchWithSearchApi("many", { numResults: 2, domainFilter: ["example.com", "example.org"] });
			console.log(JSON.stringify({ query, urls: result.results.map(entry => entry.url) }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.query, "many (site:example.com OR site:example.org)");
		assert.deepEqual(output.urls, ["https://example.com/0", "https://example.com/1"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("SearchApi retains credentials for same-origin redirects and strips them cross-origin", async () => {
	const home = await createHome({ searchapiApiKey: "searchapi-test-key" });
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url, init) => {
				const target = String(url);
				calls.push({ target, key: new Headers(init.headers).get("Authorization"), redirect: init.redirect });
				if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/api/v1/redirected" } });
				if (calls.length === 2) return new Response(null, { status: 307, headers: { location: "https://results.example/search" } });
				return new Response(${JSON.stringify(organic([{ title: "Result", link: "https://example.com/result" }]))});
			};
			const { searchWithSearchApi } = await import(${JSON.stringify(searchapiModuleUrl)});
			await searchWithSearchApi("redirect");
			console.log(JSON.stringify(calls));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const calls = JSON.parse(child.stdout.trim());
		assert.deepEqual(calls, [
			{ target: `${SEARCH_URL}?engine=google&q=redirect`, key: "Bearer searchapi-test-key", redirect: "manual" },
			{ target: "https://www.searchapi.io/api/v1/redirected", key: "Bearer searchapi-test-key", redirect: "manual" },
			{ target: "https://results.example/search", key: null, redirect: "manual" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("SearchApi publishes only absolute HTTP(S) result URLs", async () => {
	const home = await createHome({ searchapiApiKey: "searchapi-test-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async () => new Response(${JSON.stringify(organic([
				{ title: "HTTPS", link: "https://example.com/secure" },
				{ title: "HTTP", link: "http://example.com/plain" },
				{ title: "Relative", link: "/relative" },
				{ title: "Malformed", link: "not a url" },
				{ title: "File", link: "file:///tmp/result" },
				{ title: "Data", link: "data:text/plain,result" },
				{ title: "Missing link" },
				null,
			]))});
			const { searchWithSearchApi } = await import(${JSON.stringify(searchapiModuleUrl)});
			const result = await searchWithSearchApi("links", { numResults: 10 });
			console.log(JSON.stringify(result.results));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), [
			{ title: "HTTPS", url: "https://example.com/secure", snippet: "" },
			{ title: "HTTP", url: "http://example.com/plain", snippet: "" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("SearchApi needs a key and resolves config, environment, and $NAME credential sources", async () => {
	const home = await createHome();
	try {
		const missing = runChild(`
			const { searchWithSearchApi, isSearchApiAvailable } = await import(${JSON.stringify(searchapiModuleUrl)});
			let error; try { await searchWithSearchApi("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify({ available: isSearchApiAvailable(), error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(missing.status, 0, missing.stderr);
		const output = JSON.parse(missing.stdout.trim());
		assert.equal(output.available, false);
		assert.match(output.error, /^SearchApi API key not found\. Either:/);
		assert.match(output.error, /"searchapiApiKey": "your-key"/);
		assert.match(output.error, /SEARCHAPI_API_KEY environment variable/);
		assert.match(output.error, /https:\/\/www\.searchapi\.io/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
	for (const [config, env, expected] of [
		[{ searchapiApiKey: "config-key" }, {}, "Bearer config-key"],
		[{}, { SEARCHAPI_API_KEY: "env-key" }, "Bearer env-key"],
		[{ searchapiApiKey: "$SEARCHAPI_VAULT_KEY" }, { SEARCHAPI_VAULT_KEY: "vault-key" }, "Bearer vault-key"],
	]) {
		const sourceHome = await createHome(config);
		try {
			const child = runChild(`
				let auth;
				globalThis.fetch = async (url, init) => { auth = new Headers(init.headers).get("Authorization"); return new Response(${JSON.stringify(organic([]))}); };
				const { searchWithSearchApi, isSearchApiAvailable } = await import(${JSON.stringify(searchapiModuleUrl)});
				const available = isSearchApiAvailable();
				const result = await searchWithSearchApi("q");
				console.log(JSON.stringify({ available, auth, results: result.results }));
			`, { PI_CODING_AGENT_DIR: sourceHome, ...env });
			assert.equal(child.status, 0, child.stderr);
			assert.deepEqual(JSON.parse(child.stdout.trim()), { available: true, auth: expected, results: [] });
		} finally {
			await rm(sourceHome, { recursive: true, force: true });
		}
	}
});

test("SearchApi supports explicit selection but is excluded from auto and provider all", async () => {
	const home = await createHome({ searchapiApiKey: "searchapi-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith(${JSON.stringify(SEARCH_URL + "?")})) return new Response(${JSON.stringify(organic([{ title: "SearchApi", link: "https://example.com", snippet: "result" }]))}, { status: 200 });
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search, ALL_SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS, providerLabel } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "searchapi" });
		const auto = await search("auto", { provider: "auto" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({
			explicitProvider: explicit.provider, autoProvider: auto.provider, allProviders: all.providerResponses.map(result => result.provider), calls,
			resolved: RESOLVED_SEARCH_PROVIDERS.includes("searchapi"), inAll: ALL_SEARCH_PROVIDERS.includes("searchapi"), label: providerLabel("searchapi"),
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.explicitProvider, "searchapi");
	assert.equal(output.autoProvider, "exa");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.calls.filter(url => url.startsWith(SEARCH_URL + "?")).length, 1);
	assert.equal(output.resolved, true);
	assert.equal(output.inAll, false);
	assert.equal(output.label, "SearchApi");
	await rm(home, { recursive: true, force: true });
});

test("SearchApi provider timeouts can fall through configured routing", async () => {
	const home = await createHome({
		searchapiApiKey: "searchapi-test-key",
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["searchapi", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith(${JSON.stringify(SEARCH_URL + "?")})) {
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
	assert.ok(output.calls[0].startsWith(SEARCH_URL + "?"));
	assert.ok(output.calls[1].startsWith("https://api.search.brave.com/res/v1/web/search"));
	await rm(home, { recursive: true, force: true });
});

test("SearchApi errors keep the HTTP status so searchRouting classifies quota and auth failures", async () => {
	for (const [status, kind, fallsBack] of [[429, "quota", true], [503, "transient", true], [401, "quota", false]]) {
		const home = await createHome({
			searchapiApiKey: "searchapi-test-key",
			braveApiKey: "brave-test-key",
			searchRouting: { providers: ["searchapi", "brave"], fallbackOn: [kind] },
		});
		try {
			const child = runChild(`
				globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL + "?")})
					? new Response(JSON.stringify({ error: "status ${status} searchapi-test-key" }), { status: ${status} })
					: new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
				const { search } = await import(${JSON.stringify(searchModuleUrl)});
				try {
					const result = await search("status route", { provider: "auto" });
					console.log(JSON.stringify({ provider: result.provider }));
				} catch (error) {
					console.log(JSON.stringify({ error: String(error) }));
				}
			`, { PI_CODING_AGENT_DIR: home });
			assert.equal(child.status, 0, child.stderr);
			const output = JSON.parse(child.stdout.trim());
			if (fallsBack) assert.equal(output.provider, "brave", `${status} should fall back on ${kind}`);
			else {
				assert.match(output.error, new RegExp(`SearchApi error ${status}: `));
				assert.match(output.error, /\[redacted\]/);
			}
			assert.doesNotMatch(child.stdout + child.stderr, /searchapi-test-key/);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
});

for (const status of [200, 503]) {
	for (const mode of ["deadline", "caller"]) {
		test(`SearchApi delayed ${status} body honors ${mode} cancellation routing`, async () => {
			const home = await createHome({
				searchapiApiKey: "searchapi-test-key",
				braveApiKey: "brave-test-key",
				searchRouting: { providers: ["searchapi", "brave"], fallbackOn: ["network"] },
			});
			try {
				const child = runChild(`
					import { createServer } from "node:http";
					const server = createServer((_request, response) => {
						response.writeHead(${status}, { "content-type": "application/json" });
						response.write("{");
					});
					await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
					const caller = new AbortController();
					const originalTimeout = AbortSignal.timeout;
					AbortSignal.timeout = ms => originalTimeout(ms === 60000 ? 1000 : ms);
					const realFetch = globalThis.fetch;
					const calls = [];
					let headersReceived = false;
					globalThis.fetch = async (url, init) => {
						const host = new URL(url).hostname;
						calls.push(host);
						if (host === "www.searchapi.io") {
							const response = await realFetch("http://127.0.0.1:" + server.address().port, init);
							headersReceived = true;
							if (${JSON.stringify(mode)} === "caller") setTimeout(() => caller.abort(), 20);
							return response;
						}
						if (host === "api.search.brave.com") return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com", description: "fallback" }] } }));
						throw new Error("Unexpected fetch " + host);
					};
					try {
						const { search } = await import(${JSON.stringify(searchModuleUrl)});
						try {
							const result = await search("delayed body", { provider: "auto", signal: caller.signal });
							console.log(JSON.stringify({ provider: result.provider, calls, headersReceived }));
						} catch (error) {
							console.log(JSON.stringify({ error: String(error), calls, headersReceived }));
						}
					} finally {
						server.closeAllConnections();
						await new Promise(resolve => server.close(resolve));
					}
				`, { PI_CODING_AGENT_DIR: home });
				assert.equal(child.status, 0, child.stderr);
				const output = JSON.parse(child.stdout.trim());
				assert.equal(output.headersReceived, true, "must reach response-body consumption before cancellation");
				if (mode === "deadline") {
					assert.equal(output.provider, "brave", output.error);
					assert.deepEqual(output.calls, ["www.searchapi.io", "api.search.brave.com"]);
				} else {
					assert.match(output.error, /searchapi search failed \(aborted\)/i);
					assert.deepEqual(output.calls, ["www.searchapi.io"]);
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}
}

test("SearchApi redacts the resolved credential in JSON error envelopes and rejects malformed bodies", async () => {
	const home = await createHome({ searchapiApiKey: "unused-config-key" });
	try {
		const child = runChild(`
			const bodies = [
				JSON.stringify({ error: "Invalid API key resolved-searchapi-secret" }),
				JSON.stringify({ search_metadata: { status: "Success" } }),
				"[]",
				"not json",
			];
			globalThis.fetch = async () => new Response(bodies.shift(), { status: 200 });
			const { searchWithSearchApi } = await import(${JSON.stringify(searchapiModuleUrl)});
			const errors = [];
			for (let index = 0; index < 4; index++) {
				try { await searchWithSearchApi("redact envelope"); errors.push(null); } catch (error) { errors.push(String(error)); }
			}
			console.log(JSON.stringify(errors));
		`, { PI_CODING_AGENT_DIR: home, SEARCHAPI_API_KEY: "resolved-searchapi-secret" });
		assert.equal(child.status, 0, child.stderr);
		const errors = JSON.parse(child.stdout.trim());
		assert.match(errors[0], /^Error: SearchApi returned invalid response: Invalid API key \[redacted\]$/);
		assert.match(errors[1], /SearchApi returned invalid response: expected organic_results array/);
		assert.match(errors[2], /SearchApi returned invalid response: expected an object envelope/);
		assert.match(errors[3], /SearchApi returned invalid JSON: /);
		assert.doesNotMatch(child.stdout + child.stderr, /resolved-searchapi-secret/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("SearchApi redacts API errors and appears in the Curator", async () => {
	const home = await createHome({ searchapiApiKey: "searchapi-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ error: "Invalid API key searchapi-secret." }), { status: 401 });
		const { searchWithSearchApi } = await import(${JSON.stringify(searchapiModuleUrl)});
		try { await searchWithSearchApi("redact"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /^Error: SearchApi error 401: \{"error":"Invalid API key \[redacted\]\."\}$/);
	assert.doesNotMatch(output.error, /searchapi-secret/);

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, searchapi: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "searchapi", "searchapi", [], null);
	assert.match(page, /data-provider="searchapi"/);
	assert.match(page, />SearchApi<\/button>/);
	assert.match(page, /provider === "searchapi"\) return "SearchApi"/);
	assert.match(page, /var providers = \[[^\]]*"searchapi"[^\]]*\]/);
	await rm(home, { recursive: true, force: true });
});

test("SearchApi is selectable through webSearch.allowedProviders and reported in availability", async () => {
	const home = await createHome({ webSearch: { allowedProviders: ["searchapi"] }, searchapiApiKey: "searchapi-test-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL + "?")})
				? new Response(${JSON.stringify(organic([{ title: "SearchApi", link: "https://example.com/searchapi", snippet: "answer" }]))}, { status: 200 })
				: new Response("unexpected " + url, { status: 500 });
			const { search, getAllowedSearchProviders, parseProviderArgument } = await import(${JSON.stringify(searchModuleUrl)});
			const response = await search("q", { provider: "searchapi" });
			let blocked; try { await search("q", { provider: "serply" }); } catch (error) { blocked = String(error); }
			console.log(JSON.stringify({ provider: response.provider, urls: response.results.map(entry => entry.url), allowed: [...getAllowedSearchProviders()], parsed: parseProviderArgument("searchapi"), blocked }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.provider, "searchapi");
		assert.deepEqual(output.urls, ["https://example.com/searchapi"]);
		assert.deepEqual(output.allowed, ["searchapi"]);
		assert.equal(output.parsed, "searchapi");
		assert.match(output.blocked, /serply/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
