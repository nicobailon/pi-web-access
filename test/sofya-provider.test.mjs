import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sofyaModuleUrl = new URL("../sofya.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const SEARCH_URL = "https://sofya.co/v1/search";

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-sofya-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "SOFYA_API_KEY", "SOFYA_BASE_URL", "SERPLY_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY",
		"FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY",
		"SERPAPI_KEY", "SERPER_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "BRIGHTDATA_API_KEY", "VALYU_API_KEY",
		"SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

const hits = entries => JSON.stringify({ query: "q", results: entries, credits_used: 1, credits_remaining: 99 });

test("Sofya maps search hits, domain filters, and environment credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...(init && init.headers) }, body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(hits([
				{ rank: 1, title: "Allowed", url: "https://docs.example.com/a", content: "result" },
				{ rank: 2, title: "Excluded", url: "https://private.docs.example.com/b", content: "private" },
				{ rank: 3, title: "Outside", url: "https://example.net/c", content: "outside" },
			]))}, { status: 200 });
		};
		const { searchWithSofya } = await import(${JSON.stringify(sofyaModuleUrl)});
		const result = await searchWithSofya("web query", { numResults: 3, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week" });
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home, SOFYA_API_KEY: "sofya-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());
	assert.equal(captured.url, SEARCH_URL, "the key must travel in the header, never the query string");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.Authorization, "Bearer sofya-test-key");
	assert.equal(captured.headers["Content-Type"], "application/json");
	assert.equal(captured.headers["User-Agent"], "pi-web-access");
	assert.deepEqual(captured.body, { query: "web query", search_depth: "snippets", max_results: 3, include_domains: ["example.com"], exclude_domains: ["private.docs.example.com"], freshness: "week" });
	assert.deepEqual(result.results, [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }]);
	await rm(home, { recursive: true, force: true });
});

test("Sofya sends numResults as max_results and maps recency to freshness", async () => {
	const home = await createHome({ sofyaApiKey: "sofya-test-key" });
	try {
		const child = runChild(`
			const bodies = [];
			globalThis.fetch = async (_url, init) => {
				bodies.push(JSON.parse(init.body));
				return new Response(${JSON.stringify(hits([{ title: "Result", url: "https://example.com/result", content: "" }]))});
			};
			const { searchWithSofya } = await import(${JSON.stringify(sofyaModuleUrl)});
			for (const recencyFilter of [undefined, "day", "year"]) await searchWithSofya("recency", { recencyFilter });
			await searchWithSofya("many", { numResults: 50 });
			await searchWithSofya("headroom", { numResults: 18, domainFilter: ["example.com"] });
			console.log(JSON.stringify(bodies));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), [
			{ query: "recency", search_depth: "snippets", max_results: 5 },
			{ query: "recency", search_depth: "snippets", max_results: 5, freshness: "day" },
			{ query: "recency", search_depth: "snippets", max_results: 5, freshness: "year" },
			{ query: "many", search_depth: "snippets", max_results: 20 },
			{ query: "headroom", search_depth: "snippets", max_results: 18, include_domains: ["example.com"] },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Sofya trims results to numResults and sends several allowed domains", async () => {
	const home = await createHome({ sofyaApiKey: "sofya-test-key" });
	try {
		const child = runChild(`
			let domains;
			globalThis.fetch = async (_url, init) => {
				domains = JSON.parse(init.body).include_domains;
				return new Response(${JSON.stringify(hits(Array.from({ length: 10 }, (_, index) => ({ title: "Result " + index, url: "https://example.com/" + index, content: "" }))))});
			};
			const { searchWithSofya } = await import(${JSON.stringify(sofyaModuleUrl)});
			const result = await searchWithSofya("many", { numResults: 2, domainFilter: ["example.com", "example.org"] });
			console.log(JSON.stringify({ domains, urls: result.results.map(entry => entry.url) }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.domains, ["example.com", "example.org"]);
		assert.deepEqual(output.urls, ["https://example.com/0", "https://example.com/1"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Sofya retains credentials for same-origin redirects and strips them cross-origin", async () => {
	const home = await createHome({ sofyaApiKey: "sofya-test-key" });
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
			const { searchWithSofya } = await import(${JSON.stringify(sofyaModuleUrl)});
			await searchWithSofya("redirect");
			console.log(JSON.stringify(calls));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const calls = JSON.parse(child.stdout.trim());
		assert.deepEqual(calls, [
			{ target: SEARCH_URL, key: "Bearer sofya-test-key", method: "POST", redirect: "manual" },
			{ target: "https://sofya.co/v1/redirected", key: "Bearer sofya-test-key", method: "POST", redirect: "manual" },
			{ target: "https://results.example/search", key: null, method: "POST", redirect: "manual" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Sofya publishes only absolute HTTP(S) result URLs", async () => {
	const home = await createHome({ sofyaApiKey: "sofya-test-key" });
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
			const { searchWithSofya } = await import(${JSON.stringify(sofyaModuleUrl)});
			const result = await searchWithSofya("links", { numResults: 10 });
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

test("Sofya needs a key and resolves config, environment, and $NAME credential sources", async () => {
	const home = await createHome();
	try {
		const missing = runChild(`
			const { searchWithSofya, isSofyaAvailable } = await import(${JSON.stringify(sofyaModuleUrl)});
			let error; try { await searchWithSofya("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify({ available: isSofyaAvailable(), error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(missing.status, 0, missing.stderr);
		const output = JSON.parse(missing.stdout.trim());
		assert.equal(output.available, false);
		assert.match(output.error, /^Sofya API key not found\. Either:/);
		assert.match(output.error, /"sofyaApiKey": "your-key"/);
		assert.match(output.error, /SOFYA_API_KEY environment variable/);
		assert.match(output.error, /https:\/\/sofya\.co\/dashboard/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
	for (const [config, env, expected] of [
		[{ sofyaApiKey: "config-key" }, {}, "Bearer config-key"],
		[{}, { SOFYA_API_KEY: "env-key" }, "Bearer env-key"],
		[{ sofyaApiKey: "$SOFYA_VAULT_KEY" }, { SOFYA_VAULT_KEY: "vault-key" }, "Bearer vault-key"],
	]) {
		const sourceHome = await createHome(config);
		try {
			const child = runChild(`
				let auth;
				globalThis.fetch = async (url, init) => { auth = new Headers(init.headers).get("Authorization"); return new Response(${JSON.stringify(hits([]))}); };
				const { searchWithSofya, isSofyaAvailable } = await import(${JSON.stringify(sofyaModuleUrl)});
				const available = isSofyaAvailable();
				const result = await searchWithSofya("q");
				console.log(JSON.stringify({ available, auth, results: result.results }));
			`, { PI_CODING_AGENT_DIR: sourceHome, ...env });
			assert.equal(child.status, 0, child.stderr);
			assert.deepEqual(JSON.parse(child.stdout.trim()), { available: true, auth: expected, results: [] });
		} finally {
			await rm(sourceHome, { recursive: true, force: true });
		}
	}
});

test("Sofya supports explicit selection but is excluded from auto and provider all", async () => {
	const home = await createHome({ sofyaApiKey: "sofya-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith(${JSON.stringify(SEARCH_URL)})) return new Response(${JSON.stringify(hits([{ title: "Sofya", url: "https://example.com", content: "result" }]))}, { status: 200 });
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search, ALL_SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS, providerLabel } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "sofya" });
		const auto = await search("auto", { provider: "auto" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({
			explicitProvider: explicit.provider, autoProvider: auto.provider, allProviders: all.providerResponses.map(result => result.provider), calls,
			resolved: RESOLVED_SEARCH_PROVIDERS.includes("sofya"), inAll: ALL_SEARCH_PROVIDERS.includes("sofya"), label: providerLabel("sofya"),
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.explicitProvider, "sofya");
	assert.equal(output.autoProvider, "exa");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.calls.filter(url => url === SEARCH_URL).length, 1);
	assert.equal(output.resolved, true);
	assert.equal(output.inAll, false);
	assert.equal(output.label, "Sofya");
	await rm(home, { recursive: true, force: true });
});

test("Sofya provider timeouts can fall through configured routing", async () => {
	const home = await createHome({
		sofyaApiKey: "sofya-test-key",
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["sofya", "brave"], fallbackOn: ["network"] },
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

test("Sofya errors keep the HTTP status so searchRouting classifies quota and auth failures", async () => {
	for (const [status, kind, fallsBack] of [[429, "quota", true], [503, "transient", true], [401, "quota", false]]) {
		const home = await createHome({
			sofyaApiKey: "sofya-test-key",
			braveApiKey: "brave-test-key",
			searchRouting: { providers: ["sofya", "brave"], fallbackOn: [kind] },
		});
		try {
			const child = runChild(`
				globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL)})
					? new Response(JSON.stringify({ error: "status ${status} sofya-test-key" }), { status: ${status} })
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
				assert.match(output.error, new RegExp(`Sofya error ${status}: `));
				assert.match(output.error, /\[redacted\]/);
			}
			assert.doesNotMatch(child.stdout + child.stderr, /sofya-test-key/);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
});

for (const status of [200, 503]) {
	for (const mode of ["deadline", "caller"]) {
		test(`Sofya delayed ${status} body honors ${mode} cancellation routing`, async () => {
			const home = await createHome({
				sofyaApiKey: "sofya-test-key",
				braveApiKey: "brave-test-key",
				searchRouting: { providers: ["sofya", "brave"], fallbackOn: ["network"] },
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
						if (host === "sofya.co") {
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
					assert.deepEqual(output.calls, ["sofya.co", "api.search.brave.com"]);
				} else {
					assert.match(output.error, /sofya search failed \(aborted\)/i);
					assert.deepEqual(output.calls, ["sofya.co"]);
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}
}

test("Sofya redacts the resolved credential in JSON error envelopes and rejects malformed bodies", async () => {
	const home = await createHome({ sofyaApiKey: "unused-config-key" });
	try {
		const child = runChild(`
			const bodies = [
				JSON.stringify({ detail: "Invalid API key resolved-sofya-secret" }),
				JSON.stringify({ credits_used: 1 }),
				"[]",
				"not json",
			];
			globalThis.fetch = async () => new Response(bodies.shift(), { status: 200 });
			const { searchWithSofya } = await import(${JSON.stringify(sofyaModuleUrl)});
			const errors = [];
			for (let index = 0; index < 4; index++) {
				try { await searchWithSofya("redact envelope"); errors.push(null); } catch (error) { errors.push(String(error)); }
			}
			console.log(JSON.stringify(errors));
		`, { PI_CODING_AGENT_DIR: home, SOFYA_API_KEY: "resolved-sofya-secret" });
		assert.equal(child.status, 0, child.stderr);
		const errors = JSON.parse(child.stdout.trim());
		assert.match(errors[0], /^Error: Sofya returned invalid response: Invalid API key \[redacted\]$/);
		assert.match(errors[1], /Sofya returned invalid response: expected results array/);
		assert.match(errors[2], /Sofya returned invalid response: expected an object envelope/);
		assert.match(errors[3], /Sofya returned invalid JSON: /);
		assert.doesNotMatch(child.stdout + child.stderr, /resolved-sofya-secret/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Sofya redacts API errors and appears in the Curator", async () => {
	const home = await createHome({ sofyaApiKey: "sofya-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Invalid API key sofya-secret." }), { status: 401 });
		const { searchWithSofya } = await import(${JSON.stringify(sofyaModuleUrl)});
		try { await searchWithSofya("redact"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /^Error: Sofya error 401: \{"detail":"Invalid API key \[redacted\]\."\}$/);
	assert.doesNotMatch(output.error, /sofya-secret/);

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, sofya: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "sofya", "sofya", [], null);
	assert.match(page, /data-provider="sofya"/);
	assert.match(page, />Sofya<\/button>/);
	assert.match(page, /provider === "sofya"\) return "Sofya"/);
	assert.match(page, /var providers = \[[^\]]*"sofya"[^\]]*\]/);
	await rm(home, { recursive: true, force: true });
});

test("Sofya is selectable through webSearch.allowedProviders and reported in availability", async () => {
	const home = await createHome({ webSearch: { allowedProviders: ["sofya"] }, sofyaApiKey: "sofya-test-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL)})
				? new Response(${JSON.stringify(hits([{ title: "Sofya", url: "https://example.com/sofya", content: "answer" }]))}, { status: 200 })
				: new Response("unexpected " + url, { status: 500 });
			const { search, getAllowedSearchProviders, parseProviderArgument } = await import(${JSON.stringify(searchModuleUrl)});
			const response = await search("q", { provider: "sofya" });
			let blocked; try { await search("q", { provider: "serply" }); } catch (error) { blocked = String(error); }
			console.log(JSON.stringify({ provider: response.provider, urls: response.results.map(entry => entry.url), allowed: [...getAllowedSearchProviders()], parsed: parseProviderArgument("sofya"), blocked }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.provider, "sofya");
		assert.deepEqual(output.urls, ["https://example.com/sofya"]);
		assert.deepEqual(output.allowed, ["sofya"]);
		assert.equal(output.parsed, "sofya");
		assert.match(output.blocked, /serply/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
