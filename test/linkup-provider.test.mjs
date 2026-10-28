import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = name => new URL(`../${name}.ts`, import.meta.url).href;
const result = (url = "https://example.com/page", content = "Page content") => ({ type: "text", name: "Page", url, content, favicon: "" });
const response = entries => `new Response(${JSON.stringify(JSON.stringify({ results: entries }))})`;

async function child(config, script, extraEnv = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-linkup-"));
	try {
		await writeFile(join(home, "web-search.json"), typeof config === "string" ? config : JSON.stringify(config));
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (/API_KEY|_KEY$|^SEARXNG_|^PI_WEB_ACCESS_CACHE_ROOT$/.test(key)) delete env[key];
		}
		Object.assign(env, { PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: home, USERPROFILE: home }, extraEnv);
		const run = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
		assert.equal(run.status, 0, run.stderr);
		return JSON.parse(run.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const importProvider = `const { searchWithLinkup, isLinkupAvailable } = await import(${JSON.stringify(moduleUrl("linkup"))});`;
const importSearch = `const { search } = await import(${JSON.stringify(moduleUrl("gemini-search"))});`;

test("Linkup posts searchResults with fast depth and maps bounded, deduplicated text sources", async () => {
	const output = await child({ linkupApiKey: "key" }, `
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
			return ${response([
				result(undefined, "First line\n\n" + "x".repeat(6000)), result(),
				{ ...result("https://example.org"), name: " " },
				{ type: "image", name: "Image", url: "https://example.com/image" },
				result("file:///tmp/private"), result("javascript:alert(1)"), null,
			])};
		};
		${importProvider}
		const output = await searchWithLinkup("question", { numResults: 50, includeContent: true });
		console.log(JSON.stringify({ captured, available: isLinkupAvailable(), output }));
	`);
	assert.equal(output.available, true);
	assert.equal(output.captured.url, "https://api.linkup.so/v1/search");
	assert.equal(output.captured.method, "POST");
	assert.equal(output.captured.headers.Authorization, "Bearer key");
	assert.deepEqual(output.captured.body, { q: "question", depth: "fast", outputType: "searchResults", maxResults: 20 });
	assert.equal(output.output.results.length, 2);
	assert.equal(output.output.results[0].snippet.length, 500);
	assert.equal(output.output.results[1].title, "Source 2");
	assert.equal(output.output.inlineContent[0].content.length, 4000);
	assert.ok(output.output.inlineContent[0].content.startsWith("First line\n\n"));
	assert.match(output.output.answer, /Source: Page/);
});

test("Linkup supports each configured depth, defaults to five sources, and omits inline content unless requested", async () => {
	for (const depth of ["flash", "fast", "standard", "deep"]) {
		const output = await child({ linkupApiKey: "k", linkupDepth: depth }, `
			let body;
			globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return ${response(Array.from({ length: 10 }, (_, i) => result(`https://example.com/${i}`)))}; };
			${importProvider}
			const output = await searchWithLinkup("q");
			console.log(JSON.stringify({ body, output }));
		`);
		assert.equal(output.body.depth, depth);
		assert.equal(output.body.maxResults, 5);
		assert.equal(output.output.results.length, 5);
		assert.equal(output.output.inlineContent, undefined);
	}
});

test("Linkup normalizes domain filters, sends fromDate, and reapplies exclusions locally", async () => {
	const output = await child({ linkupApiKey: "k" }, `
		Date.now = () => Date.parse("2026-06-15T12:00:00Z");
		const bodies = [];
		globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return ${response([
			result("https://docs.example.com/a"), result("https://private.docs.example.com/b"),
			result("https://example.net/c"), result("https://notexample.com/d"),
		])}; };
		${importProvider}
		const outputs = [];
		for (const recencyFilter of ["day", "week", "month", "year"]) outputs.push(await searchWithLinkup("q", {
			recencyFilter, domainFilter: ["https://EXAMPLE.com/path", "example.com", "-private.docs.example.com"], numResults: 3,
		}));
		console.log(JSON.stringify({ bodies, outputs }));
	`);
	assert.deepEqual(output.bodies.map(b => b.fromDate), ["2026-06-14", "2026-06-08", "2026-05-16", "2025-06-15"]);
	for (const body of output.bodies) {
		assert.deepEqual(body.includeDomains, ["example.com"]);
		assert.deepEqual(body.excludeDomains, ["private.docs.example.com"]);
		assert.equal(body.q, "q");
	}
	for (const entry of output.outputs) assert.deepEqual(entry.results.map(r => r.url), ["https://docs.example.com/a"]);
});

test("Linkup requires a key and rejects invalid config before fetching", async () => {
	for (const [config, options, pattern] of [
		[{}, {}, /Linkup API key not found/],
		[{ linkupApiKey: "k", linkupDepth: "expensive-typo" }, {}, /linkupDepth.*must be one of/],
		[{ linkupApiKey: "k", linkupDepth: null }, {}, /linkupDepth.*must be one of/],
		[{ linkupApiKey: "k" }, { domainFilter: Array.from({ length: 101 }, (_, i) => `${i}.example.com`) }, /at most 100/],
		['{"linkupApiKey":"secret", broken', {}, /Failed to parse.*expected valid JSON/],
		[[], {}, /expected a JSON object/],
	]) {
		const output = await child(config, `
			let calls = 0;
			globalThis.fetch = async () => { calls++; throw new Error("unexpected fetch"); };
			${importProvider}
			let error;
			try { await searchWithLinkup("q", ${JSON.stringify(options)}); } catch (e) { error = String(e); }
			console.log(JSON.stringify({ calls, error }));
		`);
		assert.equal(output.calls, 0);
		assert.match(output.error, pattern);
		assert.doesNotMatch(output.error, /secret/);
	}
});

test("Linkup uses shared environment, explicit environment source, and command credentials", async () => {
	for (const [key, env, expected] of [
		["config-key", { LINKUP_API_KEY: "env-key" }, "env-key"],
		["$LINKUP_TEST_KEY", { LINKUP_TEST_KEY: "scoped-key", LINKUP_API_KEY: "ignored" }, "scoped-key"],
		["!printf command-key", {}, "command-key"],
	]) {
		const output = await child({ linkupApiKey: key }, `
			let authorization;
			globalThis.fetch = async (_url, init) => { authorization = new Headers(init.headers).get("Authorization"); return ${response([])}; };
			${importProvider}
			const available = isLinkupAvailable();
			await searchWithLinkup("q");
			console.log(JSON.stringify({ available, authorization }));
		`, env);
		assert.equal(output.available, true);
		assert.equal(output.authorization, `Bearer ${expected}`);
	}
});

test("Linkup rejects invalid responses and redacts credentials from HTTP, JSON, and transport errors", async () => {
	const output = await child({ linkupApiKey: "linkup-secret" }, `
		const responses = [
			new Response("invalid key linkup-secret", { status: 401 }),
			new Response('{"key":"linkup-secret", broken'),
			new Response(JSON.stringify({ error: "failed" })),
			new Response(JSON.stringify({ results: null })),
			new Response("[]"),
		];
		globalThis.fetch = async () => { if (responses.length) return responses.shift(); throw new TypeError("fetch failed linkup-secret"); };
		${importProvider}
		const errors = [];
		for (let i = 0; i < 6; i++) try { await searchWithLinkup("q"); } catch (e) { errors.push(String(e)); }
		console.log(JSON.stringify(errors));
	`);
	assert.match(output[0], /Linkup error 401: invalid key \[redacted\]/);
	assert.match(output[1], /Linkup returned invalid JSON/);
	for (const error of output.slice(2, 5)) assert.match(error, /invalid response/);
	assert.match(output[5], /TypeError: fetch failed \[redacted\]/);
	assert.ok(output.every(e => !e.includes("linkup-secret")));
});

test("Linkup applies the deadline through body parsing and distinguishes caller cancellation", async () => {
	const output = await child({ linkupApiKey: "k" }, `
		const timeouts = [];
		AbortSignal.timeout = ms => { timeouts.push(ms); return new AbortController().signal; };
		globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new DOMException("deadline", "TimeoutError"); } });
		${importProvider}
		let timeout, abort;
		// Simulate expiration during JSON decoding, not only while fetching headers.
		AbortSignal.timeout = ms => { timeouts.push(ms); return AbortSignal.abort(new DOMException("deadline", "TimeoutError")); };
		try { await searchWithLinkup("q"); } catch (e) { timeout = String(e); }
		const controller = new AbortController();
		globalThis.fetch = async () => { controller.abort(); throw new DOMException("cancel", "AbortError"); };
		try { await searchWithLinkup("q", { signal: controller.signal }); } catch (e) { abort = String(e); }
		console.log(JSON.stringify({ timeout, abort, timeouts }));
	`);
	assert.match(output.timeout, /timed out after 60s/);
	assert.match(output.abort, /Aborted/);
	assert.ok(output.timeouts.every(ms => ms === 60_000));
});

test("Linkup strips Authorization on cross-origin API redirects", async () => {
	const output = await child({ linkupApiKey: "secret" }, `
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), authorization: new Headers(init.headers).get("Authorization"), redirect: init.redirect });
			return calls.length === 1 ? new Response(null, { status: 307, headers: { location: "https://other.example/search" } }) : ${response([])};
		};
		${importProvider}
		await searchWithLinkup("q");
		console.log(JSON.stringify(calls));
	`);
	assert.equal(output[0].authorization, "Bearer secret");
	assert.equal(output[1].authorization, null);
	assert.ok(output.every(c => c.redirect === "manual"));
});

test("Linkup supports explicit, array, configured-default and fallback selection without joining auto or all", async () => {
	const config = { linkupApiKey: "k", webSearch: { allowedProviders: ["linkup", "exa"] } };
	const output = await child(config, `
		const calls = [];
		globalThis.fetch = async url => {
			calls.push(String(url));
			if (String(url) === "https://api.linkup.so/v1/search") return ${response([result()])};
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }));
		};
		${importSearch}
		const explicit = await search("q", { provider: "linkup" });
		const array = await search("q", { provider: ["linkup", "exa"] });
		const auto = await search("q", { provider: "auto" });
		const all = await search("q", { provider: "all" });
		console.log(JSON.stringify({ explicit: explicit.provider, array: array.providerResponses.map(r => r.provider), auto: auto.provider, all: all.providerResponses.map(r => r.provider), calls }));
	`);
	assert.equal(output.explicit, "linkup");
	assert.deepEqual(output.array, ["linkup", "exa"]);
	assert.equal(output.auto, "exa");
	assert.deepEqual(output.all, ["exa"]);
	assert.equal(output.calls.filter(url => url === "https://api.linkup.so/v1/search").length, 2);
	for (const routing of [{ provider: "linkup" }, { searchRouting: { providers: ["exa", "linkup"], fallbackOn: ["network"] } }]) {
		const output = await child({ ...config, ...routing }, `
			globalThis.fetch = async url => { if (String(url) === "https://api.linkup.so/v1/search") return ${response([result()])}; throw new TypeError("fetch failed"); };
			${importSearch}
			console.log(JSON.stringify({ provider: (await search("q")).provider }));
		`);
		assert.equal(output.provider, "linkup");
	}
});

test("Linkup preserves network fallback for header and response-body transport failures", async () => {
	for (const stage of ["headers", "body"]) {
		const output = await child({
			linkupApiKey: "secret", ceramicApiKey: "c",
			searchRouting: { providers: ["linkup", "ceramic"], fallbackOn: ["network"] },
		}, `
			const calls = [];
			globalThis.fetch = async url => {
				calls.push(String(url));
				if (String(url) === "https://api.linkup.so/v1/search") {
					if (${JSON.stringify(stage)} === "headers") throw new TypeError("terminated secret");
					return { ok: true, status: 200, json: async () => { throw new TypeError("terminated secret"); } };
				}
				return new Response(JSON.stringify({ result: { results: [{ title: "Fallback", url: "https://example.com", description: "ok" }] } }));
			};
			${importSearch}
			const output = await search("q");
			console.log(JSON.stringify({ provider: output.provider, calls }));
		`);
		assert.equal(output.provider, "ceramic");
		assert.equal(output.calls.length, 2);
	}
});

test("Linkup is exposed in Pi and MCP schemas and Curator, and obeys the provider allowlist", async () => {
	const output = await child({ linkupApiKey: "k", webSearch: { allowedProviders: ["linkup"] } }, `
		const tools = [];
		(await import(${JSON.stringify(moduleUrl("index"))})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
		const { MCP_TOOL_DEFINITIONS, validateMcpToolArguments } = await import(${JSON.stringify(moduleUrl("mcp-tool-definitions"))});
		const mcpErrors = MCP_TOOL_DEFINITIONS.filter(t => ["web_search", "source_check"].includes(t.name)).flatMap(t => {
			const base = t.name === "web_search" ? { query: "q" } : { claim: "q" };
			return [
				...validateMcpToolArguments(t, { ...base, provider: "linkup" }),
				...validateMcpToolArguments(t, { ...base, provider: ["linkup"] }),
			].map(problem => t.name + ": " + problem);
		});
		globalThis.fetch = async () => ${response([result()])};
		const sourceCheck = await tools.find(t => t.name === "source_check").execute("call", { claim: "q", provider: "linkup" }, undefined, undefined, { modelRegistry: {} });
		const { generateCuratorPage } = await import(${JSON.stringify(moduleUrl("curator-page"))});
		const available = new Proxy({ all: false, linkup: true }, { get: (obj, key) => obj[key] ?? false });
		const page = generateCuratorPage(["q"], "token", 20, available, "linkup", "linkup", [], null);
		console.log(JSON.stringify({ mcpErrors, sourceProvider: sourceCheck.details.artifact.provider, schemas: tools.filter(t => ["web_search", "source_check"].includes(t.name)).map(t => t.parameters.properties.provider.description), button: page.includes('data-provider="linkup"'), label: page.includes('provider === "linkup") return "Linkup"') }));
	`);
	assert.equal(output.schemas.length, 2);
	for (const description of output.schemas) assert.match(description, /Allowed: linkup\./);
	assert.deepEqual(output.mcpErrors, []);
	assert.equal(output.sourceProvider, "linkup");
	assert.equal(output.button, true);
	assert.equal(output.label, true);
	const blocked = await child({ linkupApiKey: "k", webSearch: { allowedProviders: ["exa"] } }, `
		globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
		${importSearch}
		let error; try { await search("q", { provider: "linkup" }); } catch (e) { error = String(e); }
		console.log(JSON.stringify(error));
	`);
	assert.match(blocked, /disabled provider/);
});
