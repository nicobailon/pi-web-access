import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const outcrawlModuleUrl = new URL("../outcrawl.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const SEARCH_URL = "https://api.outcrawl.ai/v1/search";

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-outcrawl-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OUTCRAWL_API_KEY", "OUTCRAWL_BASE_URL", "SERPLY_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY",
		"FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY",
		"SERPAPI_KEY", "SERPER_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "BRIGHTDATA_API_KEY", "VALYU_API_KEY",
		"SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

const hits = entries => JSON.stringify({ hits: entries, usage: { credits: "0.5" } });

test("Outcrawl maps search hits, domain filters, and environment credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...(init && init.headers) }, body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(hits([
				{ rank: 1, title: "Allowed", url: "https://docs.example.com/a", snippet: "result" },
				{ rank: 2, title: "Excluded", url: "https://private.docs.example.com/b", snippet: "private" },
				{ rank: 3, title: "Outside", url: "https://example.net/c", snippet: "outside" },
			]))}, { status: 200 });
		};
		const { searchWithOutcrawl } = await import(${JSON.stringify(outcrawlModuleUrl)});
		const result = await searchWithOutcrawl("web query", { numResults: 3, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week" });
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home, OUTCRAWL_API_KEY: "outcrawl-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());
	assert.equal(captured.url, SEARCH_URL, "the key must travel in the header, never the query string");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.Authorization, "Bearer outcrawl-test-key");
	assert.equal(captured.headers["Content-Type"], "application/json");
	assert.equal(captured.headers["User-Agent"], "pi-web-access");
	assert.deepEqual(captured.body, { query: "web query site:example.com -site:private.docs.example.com", limit: 8 });
	assert.deepEqual(result.results, [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }]);
	await rm(home, { recursive: true, force: true });
});

test("Outcrawl sends numResults as limit without filters and does not send a recency filter", async () => {
	const home = await createHome({ outcrawlApiKey: "outcrawl-test-key" });
	try {
		const child = runChild(`
			const bodies = [];
			globalThis.fetch = async (_url, init) => {
				bodies.push(JSON.parse(init.body));
				return new Response(${JSON.stringify(hits([{ title: "Result", url: "https://example.com/result", snippet: "" }]))});
			};
			const { searchWithOutcrawl } = await import(${JSON.stringify(outcrawlModuleUrl)});
			for (const recencyFilter of [undefined, "day", "year"]) await searchWithOutcrawl("recency", { recencyFilter });
			await searchWithOutcrawl("many", { numResults: 50 });
			await searchWithOutcrawl("headroom", { numResults: 18, domainFilter: ["example.com"] });
			console.log(JSON.stringify(bodies));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), [
			{ query: "recency", limit: 5 },
			{ query: "recency", limit: 5 },
			{ query: "recency", limit: 5 },
			{ query: "many", limit: 20 },
			{ query: "headroom site:example.com", limit: 20 },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Outcrawl trims hits to numResults and groups several allowed domains", async () => {
	const home = await createHome({ outcrawlApiKey: "outcrawl-test-key" });
	try {
		const child = runChild(`
			let query;
			globalThis.fetch = async (_url, init) => {
				query = JSON.parse(init.body).query;
				return new Response(${JSON.stringify(hits(Array.from({ length: 10 }, (_, index) => ({ title: "Result " + index, url: "https://example.com/" + index, snippet: "" }))))});
			};
			const { searchWithOutcrawl } = await import(${JSON.stringify(outcrawlModuleUrl)});
			const result = await searchWithOutcrawl("many", { numResults: 2, domainFilter: ["example.com", "example.org"] });
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

test("Outcrawl retains credentials for same-origin redirects and strips them cross-origin", async () => {
	const home = await createHome({ outcrawlApiKey: "outcrawl-test-key" });
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url, init) => {
				const target = String(url);
				calls.push({ target, key: new Headers(init.headers).get("Authorization"), method: init.method, redirect: init.redirect });
				if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "/v1/redirected" } });
				if (calls.length === 2) return new Response(null, { status: 308, headers: { location: "https://results.example/search" } });
				return new Response(${JSON.stringify(hits([{ title: "Result", url: "https://example.com/result" }]))});
			};
			const { searchWithOutcrawl } = await import(${JSON.stringify(outcrawlModuleUrl)});
			await searchWithOutcrawl("redirect");
			console.log(JSON.stringify(calls));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const calls = JSON.parse(child.stdout.trim());
		assert.deepEqual(calls, [
			{ target: SEARCH_URL, key: "Bearer outcrawl-test-key", method: "POST", redirect: "manual" },
			{ target: "https://api.outcrawl.ai/v1/redirected", key: "Bearer outcrawl-test-key", method: "POST", redirect: "manual" },
			{ target: "https://results.example/search", key: null, method: "POST", redirect: "manual" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Outcrawl publishes only absolute HTTP(S) result URLs", async () => {
	const home = await createHome({ outcrawlApiKey: "outcrawl-test-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async () => new Response(${JSON.stringify(hits([
				{ title: "HTTPS", url: "https://example.com/secure" },
				{ title: "HTTP", url: "http://example.com/plain" },
				{ title: "Relative", url: "/relative" },
				{ title: "Malformed", url: "not a url" },
				{ title: "File", url: "file:///tmp/result" },
				{ title: "Data", url: "data:text/plain,result" },
				{ title: "Missing url" },
				null,
			]))});
			const { searchWithOutcrawl } = await import(${JSON.stringify(outcrawlModuleUrl)});
			const result = await searchWithOutcrawl("links", { numResults: 10 });
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

test("Outcrawl needs a key and resolves config, environment, and $NAME credential sources", async () => {
	const home = await createHome();
	try {
		const missing = runChild(`
			const { searchWithOutcrawl, isOutcrawlAvailable } = await import(${JSON.stringify(outcrawlModuleUrl)});
			let error; try { await searchWithOutcrawl("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify({ available: isOutcrawlAvailable(), error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(missing.status, 0, missing.stderr);
		const output = JSON.parse(missing.stdout.trim());
		assert.equal(output.available, false);
		assert.match(output.error, /^Outcrawl API key not found\. Either:/);
		assert.match(output.error, /"outcrawlApiKey": "your-key"/);
		assert.match(output.error, /OUTCRAWL_API_KEY environment variable/);
		assert.match(output.error, /https:\/\/outcrawl\.ai/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
	for (const [config, env, expected] of [
		[{ outcrawlApiKey: "config-key" }, {}, "Bearer config-key"],
		[{}, { OUTCRAWL_API_KEY: "env-key" }, "Bearer env-key"],
		[{ outcrawlApiKey: "$OUTCRAWL_VAULT_KEY" }, { OUTCRAWL_VAULT_KEY: "vault-key" }, "Bearer vault-key"],
	]) {
		const sourceHome = await createHome(config);
		try {
			const child = runChild(`
				let auth;
				globalThis.fetch = async (url, init) => { auth = new Headers(init.headers).get("Authorization"); return new Response(${JSON.stringify(hits([]))}); };
				const { searchWithOutcrawl, isOutcrawlAvailable } = await import(${JSON.stringify(outcrawlModuleUrl)});
				const available = isOutcrawlAvailable();
				const result = await searchWithOutcrawl("q");
				console.log(JSON.stringify({ available, auth, results: result.results }));
			`, { PI_CODING_AGENT_DIR: sourceHome, ...env });
			assert.equal(child.status, 0, child.stderr);
			assert.deepEqual(JSON.parse(child.stdout.trim()), { available: true, auth: expected, results: [] });
		} finally {
			await rm(sourceHome, { recursive: true, force: true });
		}
	}
});

test("Outcrawl supports explicit selection but is excluded from auto and provider all", async () => {
	const home = await createHome({ outcrawlApiKey: "outcrawl-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith(${JSON.stringify(SEARCH_URL)})) return new Response(${JSON.stringify(hits([{ title: "Outcrawl", url: "https://example.com", snippet: "result" }]))}, { status: 200 });
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search, ALL_SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS, providerLabel } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "outcrawl" });
		const auto = await search("auto", { provider: "auto" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({
			explicitProvider: explicit.provider, autoProvider: auto.provider, allProviders: all.providerResponses.map(result => result.provider), calls,
			resolved: RESOLVED_SEARCH_PROVIDERS.includes("outcrawl"), inAll: ALL_SEARCH_PROVIDERS.includes("outcrawl"), label: providerLabel("outcrawl"),
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.explicitProvider, "outcrawl");
	assert.equal(output.autoProvider, "exa");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.calls.filter(url => url === SEARCH_URL).length, 1);
	assert.equal(output.resolved, true);
	assert.equal(output.inAll, false);
	assert.equal(output.label, "Outcrawl");
	await rm(home, { recursive: true, force: true });
});

test("Outcrawl provider timeouts can fall through configured routing", async () => {
	const home = await createHome({
		outcrawlApiKey: "outcrawl-test-key",
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["outcrawl", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith(${JSON.stringify(SEARCH_URL)})) {
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
	assert.ok(output.calls[0] === SEARCH_URL);
	assert.ok(output.calls[1].startsWith("https://api.search.brave.com/res/v1/web/search"));
	await rm(home, { recursive: true, force: true });
});

test("Outcrawl errors keep the HTTP status so searchRouting classifies quota and auth failures", async () => {
	for (const [status, kind, fallsBack] of [[429, "quota", true], [503, "transient", true], [401, "quota", false]]) {
		const home = await createHome({
			outcrawlApiKey: "outcrawl-test-key",
			braveApiKey: "brave-test-key",
			searchRouting: { providers: ["outcrawl", "brave"], fallbackOn: [kind] },
		});
		try {
			const child = runChild(`
				globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL)})
					? new Response(JSON.stringify({ error: "status ${status} outcrawl-test-key" }), { status: ${status} })
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
				assert.match(output.error, new RegExp(`Outcrawl error ${status}: `));
				assert.match(output.error, /\[redacted\]/);
			}
			assert.doesNotMatch(child.stdout + child.stderr, /outcrawl-test-key/);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
});

for (const status of [200, 503]) {
	for (const mode of ["deadline", "caller"]) {
		test(`Outcrawl delayed ${status} body honors ${mode} cancellation routing`, async () => {
			const home = await createHome({
				outcrawlApiKey: "outcrawl-test-key",
				braveApiKey: "brave-test-key",
				searchRouting: { providers: ["outcrawl", "brave"], fallbackOn: ["network"] },
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
						if (host === "api.outcrawl.ai") {
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
					assert.deepEqual(output.calls, ["api.outcrawl.ai", "api.search.brave.com"]);
				} else {
					assert.match(output.error, /outcrawl search failed \(aborted\)/i);
					assert.deepEqual(output.calls, ["api.outcrawl.ai"]);
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}
}

test("Outcrawl redacts the resolved credential in JSON error envelopes and rejects malformed bodies", async () => {
	const home = await createHome({ outcrawlApiKey: "unused-config-key" });
	try {
		const child = runChild(`
			const bodies = [
				JSON.stringify({ error: "Invalid API key resolved-outcrawl-secret" }),
				JSON.stringify({ usage: { credits: "0.5" } }),
				"[]",
				"not json",
			];
			globalThis.fetch = async () => new Response(bodies.shift(), { status: 200 });
			const { searchWithOutcrawl } = await import(${JSON.stringify(outcrawlModuleUrl)});
			const errors = [];
			for (let index = 0; index < 4; index++) {
				try { await searchWithOutcrawl("redact envelope"); errors.push(null); } catch (error) { errors.push(String(error)); }
			}
			console.log(JSON.stringify(errors));
		`, { PI_CODING_AGENT_DIR: home, OUTCRAWL_API_KEY: "resolved-outcrawl-secret" });
		assert.equal(child.status, 0, child.stderr);
		const errors = JSON.parse(child.stdout.trim());
		assert.match(errors[0], /^Error: Outcrawl returned invalid response: Invalid API key \[redacted\]$/);
		assert.match(errors[1], /Outcrawl returned invalid response: expected hits array/);
		assert.match(errors[2], /Outcrawl returned invalid response: expected an object envelope/);
		assert.match(errors[3], /Outcrawl returned invalid JSON: /);
		assert.doesNotMatch(child.stdout + child.stderr, /resolved-outcrawl-secret/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Outcrawl redacts API errors and appears in the Curator", async () => {
	const home = await createHome({ outcrawlApiKey: "outcrawl-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ error: "Invalid API key outcrawl-secret." }), { status: 401 });
		const { searchWithOutcrawl } = await import(${JSON.stringify(outcrawlModuleUrl)});
		try { await searchWithOutcrawl("redact"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /^Error: Outcrawl error 401: \{"error":"Invalid API key \[redacted\]\."\}$/);
	assert.doesNotMatch(output.error, /outcrawl-secret/);

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, outcrawl: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "outcrawl", "outcrawl", [], null);
	assert.match(page, /data-provider="outcrawl"/);
	assert.match(page, />Outcrawl<\/button>/);
	assert.match(page, /provider === "outcrawl"\) return "Outcrawl"/);
	assert.match(page, /var providers = \[[^\]]*"outcrawl"[^\]]*\]/);
	await rm(home, { recursive: true, force: true });
});

test("Outcrawl is selectable through webSearch.allowedProviders and reported in availability", async () => {
	const home = await createHome({ webSearch: { allowedProviders: ["outcrawl"] }, outcrawlApiKey: "outcrawl-test-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL)})
				? new Response(${JSON.stringify(hits([{ title: "Outcrawl", url: "https://example.com/outcrawl", snippet: "answer" }]))}, { status: 200 })
				: new Response("unexpected " + url, { status: 500 });
			const { search, getAllowedSearchProviders, parseProviderArgument } = await import(${JSON.stringify(searchModuleUrl)});
			const response = await search("q", { provider: "outcrawl" });
			let blocked; try { await search("q", { provider: "serply" }); } catch (error) { blocked = String(error); }
			console.log(JSON.stringify({ provider: response.provider, urls: response.results.map(entry => entry.url), allowed: [...getAllowedSearchProviders()], parsed: parseProviderArgument("outcrawl"), blocked }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.provider, "outcrawl");
		assert.deepEqual(output.urls, ["https://example.com/outcrawl"]);
		assert.deepEqual(output.allowed, ["outcrawl"]);
		assert.equal(output.parsed, "outcrawl");
		assert.match(output.blocked, /serply/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
