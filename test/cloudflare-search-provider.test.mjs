import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = name => JSON.stringify(new URL(`../${name}.ts`, import.meta.url).href);
const SEARCH = "https://api.cloudflare.com/client/v4/accounts/acct/ai/websearch/";
const CREDENTIALS = { cloudflareApiKey: "cf-secret", cloudflareAccountId: "acct" };
const body = items => JSON.stringify({ items, metadata: { query: "q", requestId: "req-1", latencyMs: 600 } });
const ok = urls => `new Response(${JSON.stringify(body(urls.map(url => ({ url, title: "Page", description: "Snippet" }))))})`;

async function child(config, script, env = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-cloudflare-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify(config));
		const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|_KEY$|^CLOUDFLARE_/.test(key)));
		const run = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: { ...base, PI_CODING_AGENT_DIR: home, HOME: home, USERPROFILE: home, ...env }, timeout: 20_000 });
		assert.equal(run.status, 0, run.stderr);
		return JSON.parse(run.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("Cloudflare posts the documented body with Bearer auth and maps items", async () => {
	// Item shapes as the live API returns them (cloudflare/agents web search tests).
	const items = [
		{ url: "https://blog.cloudflare.com/introducing-web-search-api/", title: "Introducing Web Search API", description: "# Introducing\n\n  Today,   we're announcing " + "x".repeat(800), imageUrl: "https://blog.cloudflare.com/og.png", lastModifiedDate: "2026-10-02T14:16:00.000Z" },
		{ url: "https://developers.cloudflare.com/ai-gateway/usage/web-search/", title: "  " },
		{ url: "https://blog.cloudflare.com/introducing-web-search-api/", title: "Duplicate" },
		{ url: "file:///tmp/x", title: "Skipped" },
		{ title: "No URL" },
	];
	const output = await child(CREDENTIALS, `
		let captured;
		globalThis.fetch = async (url, init) => { captured = { url: String(url), method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) }; return new Response(${JSON.stringify(body(items))}); };
		const { searchWithCloudflare, isCloudflareSearchAvailable } = await import(${moduleUrl("cloudflare-search")});
		const result = await searchWithCloudflare("web search api", { numResults: 20, recencyFilter: "week" });
		console.log(JSON.stringify({ captured, available: isCloudflareSearchAvailable(), result }));
	`);
	assert.equal(output.available, true);
	assert.deepEqual(output.captured, {
		url: SEARCH, method: "POST", auth: "Bearer cf-secret",
		body: { query: "web search api", provider: "ceramic", limit: 10, options: { gateway: { id: "default" } } },
	});
	const [first, second, ...rest] = output.result.results;
	assert.equal(first.title, "Introducing Web Search API");
	assert.equal(first.snippet.length, 500);
	assert.ok(first.snippet.startsWith("# Introducing Today, we're announcing x"));
	assert.deepEqual(second, { title: "https://developers.cloudflare.com/ai-gateway/usage/web-search/", url: "https://developers.cloudflare.com/ai-gateway/usage/web-search/", snippet: "" });
	assert.deepEqual(rest, []);
	assert.match(output.result.answer, /Introducing Web Search API/);
});

test("Cloudflare reads env over config, honors gateway and provider settings, and validates the provider", async () => {
	const output = await child({ cloudflareApiKey: "config-key", cloudflareAccountId: "config-acct", cloudflareGatewayId: "config-gw", cloudflareSearchProvider: "linkup" }, `
		const calls = [];
		globalThis.fetch = async (url, init) => { calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) }); return ${ok([])}; };
		const { searchWithCloudflare } = await import(${moduleUrl("cloudflare-search")});
		await searchWithCloudflare("q", { numResults: 3 });
		console.log(JSON.stringify(calls));
	`, { CLOUDFLARE_API_KEY: "env-key", CLOUDFLARE_ACCOUNT_ID: "env/acct", CLOUDFLARE_GATEWAY_ID: "env-gw", CLOUDFLARE_SEARCH_PROVIDER: "Exa" });
	assert.deepEqual(output, [{
		url: "https://api.cloudflare.com/client/v4/accounts/env%2Facct/ai/websearch/",
		auth: "Bearer env-key",
		body: { query: "q", provider: "exa", limit: 3, options: { gateway: { id: "env-gw" } } },
	}]);

	const invalid = await child({ ...CREDENTIALS, cloudflareSearchProvider: "brave" }, `
		globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
		const { searchWithCloudflare } = await import(${moduleUrl("cloudflare-search")});
		let error; try { await searchWithCloudflare("q"); } catch (e) { error = e.message; }
		console.log(JSON.stringify(error));
	`);
	assert.match(invalid, /cloudflareSearchProvider must be one of ceramic, exa, linkup; got "brave"/);
});

test("Cloudflare needs both an account ID and an API key", async () => {
	for (const [config, pattern] of [[{ cloudflareApiKey: "k" }, /account ID not found/], [{ cloudflareAccountId: "acct" }, /API key not found/]]) {
		const output = await child(config, `
			globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
			const { searchWithCloudflare, isCloudflareSearchAvailable } = await import(${moduleUrl("cloudflare-search")});
			let error; try { await searchWithCloudflare("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify({ available: isCloudflareSearchAvailable(), error }));
		`);
		assert.equal(output.available, false);
		assert.match(output.error, pattern);
	}
});

test("Cloudflare sends allowed domains as site: clauses for Ceramic only and filters domains locally", async () => {
	const results = ["https://docs.example.com/a", "https://private.docs.example.com/b", "https://example.net/c", "https://example.org/d"];
	for (const [provider, expectedQuery] of [["ceramic", "q (site:example.com OR site:example.org)"], ["exa", "q"]]) {
		const output = await child({ ...CREDENTIALS, cloudflareSearchProvider: provider }, `
			let sent;
			globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return ${ok(results)}; };
			const { searchWithCloudflare } = await import(${moduleUrl("cloudflare-search")});
			const result = await searchWithCloudflare("q", { numResults: 3, domainFilter: ["example.com", "https://example.org/", "-private.docs.example.com"] });
			console.log(JSON.stringify({ sent, urls: result.results.map(r => r.url) }));
		`);
		assert.equal(output.sent.query, expectedQuery, provider);
		assert.equal(output.sent.limit, 10, provider);
		assert.deepEqual(output.urls, ["https://docs.example.com/a", "https://example.org/d"], provider);
	}
});

test("Cloudflare rejects a query over 1024 characters with its site: clause before sending, and sends one at the limit unchanged", async () => {
	const atLimit = "a".repeat(1024 - " site:example.com".length);
	const output = await child(CREDENTIALS, `
		const sent = [];
		globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body).query); return ${ok([])}; };
		const { searchWithCloudflare } = await import(${moduleUrl("cloudflare-search")});
		await searchWithCloudflare(${JSON.stringify(atLimit)}, { domainFilter: ["example.com"] });
		let error; try { await searchWithCloudflare(${JSON.stringify(atLimit + "b")}, { domainFilter: ["example.com"] }); } catch (e) { error = e.message; }
		console.log(JSON.stringify({ sent, error }));
	`);
	assert.deepEqual(output.sent, [`${atLimit} site:example.com`]);
	assert.equal(output.error, "Cloudflare Web Search invalid request: the query is 1025 characters with domain filters; Cloudflare Web Search accepts at most 1024");
});

test("Cloudflare reports each documented error shape with its status and redacts the key", async () => {
	// Error bodies as the live API returned them (cloudflare/agents web search tests, 2026-10-05).
	const responses = [
		[402, { ok: false, error: { category: "gateway", code: "web_search_payment_required", status: 402, retryable: false, gatewayRequestId: "d51a" } }],
		[400, { success: false, errors: [{ code: 7000, message: "Invalid web search request body" }], messages: [{ code: "too_big", maximum: 10, message: "Number must be less than or equal to 10", path: ["limit"] }], result: null }],
		[400, { success: false, result: [], messages: [], error: [{ code: 2001, message: "Please configure AI Gateway in the Cloudflare dashboard" }], message: "Please configure AI Gateway in the Cloudflare dashboard" }],
		[401, "token cf-secret is invalid"],
		[200, { result: null, success: true }],
		// Live body from 2026-10-27, which adds a readable message.
		[402, { ok: false, error: { category: "gateway", code: "web_search_payment_required", status: 402, retryable: false, gatewayRequestId: "01a1", message: "Your AI Gateway credit balance is zero, so this search could not be billed." } }],
	];
	const output = await child(CREDENTIALS, `
		const queue = ${JSON.stringify(responses)};
		globalThis.fetch = async () => { const [status, value] = queue.shift(); return new Response(typeof value === "string" ? value : JSON.stringify(value), { status }); };
		const { searchWithCloudflare } = await import(${moduleUrl("cloudflare-search")});
		const errors = [];
		for (let i = 0; i < 6; i++) { try { await searchWithCloudflare("q"); } catch (e) { errors.push(e.message); } }
		console.log(JSON.stringify(errors));
	`);
	const [payment, validation, gateway, auth, malformed, livePayment] = output;
	assert.match(payment, /^Cloudflare Web Search error 402: web_search_payment_required \(no AI Gateway credits/);
	assert.equal(validation, "Cloudflare Web Search error 400: Invalid web search request body; limit: Number must be less than or equal to 10");
	assert.equal(gateway, "Cloudflare Web Search error 400: Please configure AI Gateway in the Cloudflare dashboard");
	assert.equal(auth, "Cloudflare Web Search error 401: token [redacted] is invalid");
	assert.match(malformed, /Cloudflare Web Search returned invalid response: expected items array/);
	assert.equal(livePayment, "Cloudflare Web Search error 402: web_search_payment_required: Your AI Gateway credit balance is zero, so this search could not be billed.");
});

test("Cloudflare quota failures fall back through searchRouting", async () => {
	const output = await child({ ...CREDENTIALS, ceramicApiKey: "c", searchRouting: { providers: ["cloudflare", "ceramic"], fallbackOn: ["quota"] } }, `
		globalThis.fetch = async url => String(url) === ${JSON.stringify(SEARCH)}
			? new Response(JSON.stringify({ ok: false, error: { code: "web_search_payment_required", status: 402 } }), { status: 402 })
			: new Response(JSON.stringify({ result: { results: [{ title: "Fallback", url: "https://example.com", description: "ok" }] } }));
		const { search } = await import(${moduleUrl("gemini-search")});
		console.log(JSON.stringify((await search("q")).provider));
	`);
	assert.equal(output, "ceramic");
});

test("Cloudflare is explicit-only and appears in the Curator", async () => {
	const output = await child({ ...CREDENTIALS, webSearch: { allowedProviders: ["cloudflare", "exa"] } }, `
		globalThis.fetch = async url => String(url) === ${JSON.stringify(SEARCH)}
			? ${ok(["https://example.com"])}
			: new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }));
		const { search } = await import(${moduleUrl("gemini-search")});
		const explicit = await search("q", { provider: "cloudflare" });
		const auto = await search("q", { provider: "auto" });
		const all = await search("q", { provider: "all" });
		console.log(JSON.stringify({ explicit: explicit.provider, auto: auto.provider, all: all.providerResponses.map(r => r.provider) }));
	`);
	assert.deepEqual(output, { explicit: "cloudflare", auto: "exa", all: ["exa"] });

	const { generateCuratorPage } = await import(new URL("../curator-page.ts", import.meta.url).href);
	const available = new Proxy({ all: false, cloudflare: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "cloudflare", "cloudflare", [], null);
	assert.match(page, /data-provider="cloudflare"/);
	assert.match(page, />Cloudflare<\/button>/);
});
