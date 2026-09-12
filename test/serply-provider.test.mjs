import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const serplyModuleUrl = new URL("../serply.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-serply-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "SERPLY_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY",
		"TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY",
		"JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "SERPAPI_KEY",
		"SERPER_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "BRIGHTDATA_API_KEY", "VALYU_API_KEY",
		"SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

test("Serply maps Google results, filters, recency, and environment credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured;
		let capturedHeaders;
		globalThis.fetch = async (url, init) => {
			captured = String(url);
			capturedHeaders = { ...(init && init.headers) };
			return new Response(JSON.stringify({ results: [
				{ title: "Allowed", link: "https://docs.example.com/a", description: "result" },
				{ title: "Excluded", link: "https://private.docs.example.com/b", description: "private" },
				{ title: "Outside", link: "https://example.net/c", description: "outside" }
			] }), { status: 200 });
		};
		const { searchWithSerply } = await import(${JSON.stringify(serplyModuleUrl)});
		const result = await searchWithSerply("google query", { numResults: 3, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week" });
		const url = new URL(captured);
		console.log(JSON.stringify({ origin: url.origin + url.pathname, params: Object.fromEntries(url.searchParams), headers: capturedHeaders, result }));
	`, { PI_CODING_AGENT_DIR: home, SERPLY_API_KEY: "serply-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.origin, "https://api.serply.io/v1/search");
	assert.equal(output.headers["X-Api-Key"], "serply-test-key");
	assert.equal(output.params.api_key, undefined, "the key must travel in the header, never the query string");
	assert.equal(output.params.num, "8");
	assert.equal(output.params.tbs, "qdr:w");
	assert.match(output.params.q, /site:example\.com/);
	assert.match(output.params.q, /-site:private\.docs\.example\.com/);
	assert.deepEqual(output.result.results, [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }]);
	await rm(home, { recursive: true, force: true });
});

test("Serply supports explicit routing but is excluded from provider all", async () => {
	const home = await createHome({ serplyApiKey: "serply-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://api.serply.io/v1/search?")) return new Response(JSON.stringify({ results: [{ title: "Serply", link: "https://example.com", description: "result" }] }), { status: 200 });
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "serply" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({ explicitProvider: explicit.provider, allProviders: all.providerResponses.map(result => result.provider), calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.explicitProvider, "serply");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.calls.filter(url => url.startsWith("https://api.serply.io/v1/search?")).length, 1);
	await rm(home, { recursive: true, force: true });
});

test("Serply provider timeouts can fall through configured routing", async () => {
	const home = await createHome({
		serplyApiKey: "serply-test-key",
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["serply", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://api.serply.io/v1/search?")) {
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
	assert.ok(output.calls[0].startsWith("https://api.serply.io/v1/search?"));
	assert.ok(output.calls[1].startsWith("https://api.search.brave.com/res/v1/web/search"));
	await rm(home, { recursive: true, force: true });
});

for (const status of [200, 503]) {
	for (const mode of ["deadline", "caller", "both"]) {
		test(`Serply delayed ${status} body honors ${mode} cancellation routing`, async () => {
			const home = await createHome({
				serplyApiKey: "serply-test-key",
				braveApiKey: "brave-test-key",
				searchRouting: { providers: ["serply", "brave"], fallbackOn: ["network"] },
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
					AbortSignal.timeout = ms => {
						const signal = originalTimeout(ms === 60000 ? 1000 : ms);
						if (${JSON.stringify(mode)} === "both" && ms === 60000) {
							signal.addEventListener("abort", () => caller.abort(), { once: true });
						}
						return signal;
					};
					const realFetch = globalThis.fetch;
					const calls = [];
					let headersReceived = false;
					globalThis.fetch = async (url, init) => {
						const host = new URL(url).hostname;
						calls.push(host);
						if (host === "api.serply.io") {
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
					assert.deepEqual(output.calls, ["api.serply.io", "api.search.brave.com"]);
				} else {
					assert.match(output.error, /serply search failed \(aborted\)/i);
					assert.deepEqual(output.calls, ["api.serply.io"]);
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}
}

test("Serply redacts the resolved credential in JSON error envelopes", async () => {
	const home = await createHome({ serplyApiKey: "unused-config-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Invalid API key resolved-serply-secret" }));
			const { searchWithSerply } = await import(${JSON.stringify(serplyModuleUrl)});
			try { await searchWithSerply("redact envelope"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
		`, { PI_CODING_AGENT_DIR: home, SERPLY_API_KEY: "resolved-serply-secret" });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.match(output.error, /Serply returned invalid response: Invalid API key \[redacted\]/);
		assert.doesNotMatch(child.stdout + child.stderr, /resolved-serply-secret/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Serply redacts API errors and appears in the Curator", async () => {
	const home = await createHome({ serplyApiKey: "serply-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response("invalid serply-secret", { status: 401 });
		const { searchWithSerply } = await import(${JSON.stringify(serplyModuleUrl)});
		try { await searchWithSerply("redact"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /\[redacted\]/);
	assert.doesNotMatch(output.error, /serply-secret/);

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, serply: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "serply", "serply", [], null);
	assert.match(page, /data-provider="serply"/);
	assert.match(page, />Serply<\/button>/);
	assert.match(page, /provider === "serply"\) return "Serply"/);
	await rm(home, { recursive: true, force: true });
});
