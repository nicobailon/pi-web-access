import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatSearchModel } from "../search-model.ts";

const urls = Object.fromEntries(["index", "gemini-search", "web-tool-core", "storage", "mcp-tool-definitions", "openai-search", "xai-search", "mistral-search"].map(name => [name, new URL(`../${name}.ts`, import.meta.url).href]));
const defaults = {
	openaiApiKey: "test-openai-secret", xaiApiKey: "test-xai-secret", mistralApiKey: "test-mistral-secret", geminiApiKey: "test-gemini-secret",
	openaiSearchModel: "configured-openai", xaiSearchModel: "configured-xai", mistralSearchModel: "configured-mistral", searchModel: "configured-gemini",
	webSearch: { allowedProviders: ["openai", "xai", "mistral", "gemini", "brave"] }, autoOpenBrowser: false,
};

// Isolated children keep config caches, registry credentials, and environment out
// of other scenarios. Every external transport is mocked; local curator HTTP is real.
function scenario(body, { config = {}, flags = {}, browser = false, adc = false, env = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "search-model-override-"));
	try {
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ ...defaults, ...config }));
		if (adc) writeFileSync(join(root, "adc.json"), JSON.stringify({ type: "authorized_user", client_id: "client", client_secret: "secret", refresh_token: "refresh" }));
		const childEnv = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, METADATA_SERVER_DETECTION: "none", ...env };
		for (const key of Object.keys(childEnv)) {
			if (/_API_KEY$/.test(key) || ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GCLOUD_PROJECT", "PI_ALLOW_BROWSER_COOKIES", "FEYNMAN_ALLOW_BROWSER_COOKIES"].includes(key)) delete childEnv[key];
		}
		if (adc) childEnv.GOOGLE_APPLICATION_CREDENTIALS = join(root, "adc.json");
		Object.assign(childEnv, env);
		const stub = `
			export const isGeminiWebAvailable = async () => { globalThis.browserChecks++; return { cookie: "present" }; };
			export const queryWithCookies = async () => { globalThis.browserQueries++; return "Browser answer [source](https://example.com/browser)"; };
			export const getGeminiWebAvailabilityDiagnostic = () => null;
			export const getGeminiWebAvailabilityDiagnosticDetails = () => null;
			export const getActiveGoogleEmail = async () => null;
		`;
		const loader = `export async function resolve(s, c, next) {
			if (s.endsWith("/gemini-web.ts")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(stub))}, shortCircuit: true };
			return next(s, c);
		}`;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			encoding: "utf8", timeout: 25_000, maxBuffer: 4 * 1024 * 1024, env: childEnv,
			input: `
				import assert from "node:assert/strict";
				import { readFileSync } from "node:fs";
				import { register } from "node:module";
				const urls = ${JSON.stringify(urls)}, flags = ${JSON.stringify(flags)}, root = ${JSON.stringify(root)};
				globalThis.browserChecks = 0; globalThis.browserQueries = 0;
				${browser ? `register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);` : ""}
				const nativeFetch = globalThis.fetch, requests = [], authCalls = [];
				globalThis.fetch = async (input, init = {}) => {
					const url = String(input instanceof Request ? input.url : input);
					if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) return nativeFetch(input, init);
					init.signal?.throwIfAborted();
					const body = init.body && !url.includes("oauth2.googleapis.com/token") ? JSON.parse(init.body) : null;
					requests.push({ url, body, headers: Object.fromEntries(new Headers(init.headers)) });
					if (flags.abort) throw new DOMException("Aborted", "AbortError");
					if (flags.network) throw new TypeError("fetch failed test-openai-secret test-xai-secret test-mistral-secret test-gemini-secret");
					if (flags.status) return new Response("model/tool unavailable quota test-openai-secret test-xai-secret test-mistral-secret test-gemini-secret", { status: flags.status });
					if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "adc-access-token", expires_in: 3600 });
					const model = body?.model ?? decodeURIComponent(url.match(/models\\/(.*):generateContent/)?.[1] ?? "");
					const reported = flags.noReturnedModel ? {} : { model: model + "-reported" };
					if (flags.empty) return Response.json({ output: [], candidates: [], outputs: [] });
					if (url.includes(":generateContent")) return Response.json({ ...(flags.noReturnedModel ? {} : { modelVersion: model + "-reported" }), candidates: [{ content: { parts: [{ text: "Gemini answer" }] }, groundingMetadata: { groundingChunks: [] } }] });
					if (url.includes("/conversations")) return Response.json({ ...reported, outputs: [{ type: "message.output", content: "Mistral answer" }] });
					if (url.includes("/alpha/search")) return Response.json({ ...reported, output: "Alpha answer", results: [] });
					if (url.includes("/responses")) return Response.json({ ...reported, output: [{ type: "web_search_call", action: { sources: [] } }, { type: "message", content: [{ type: "output_text", text: "Responses answer" }] }] });
					throw new Error("Unexpected request " + url);
				};
				const catalog = [
					{ id: "gpt-6-luna", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
					{ id: "grok-4.5", provider: "xai", baseUrl: "https://api.x.ai/v1" },
				];
				const mainModel = { id: "claude-test", provider: "anthropic", baseUrl: "https://api.anthropic.com" };
				const ctx = { model: mainModel, scopedModels: [], cwd: root, hasUI: true, ui: { notify() {} }, sessionManager: { getSessionId: () => "test-session", getBranch: () => [] }, modelRegistry: {
					getAll: () => catalog, getAvailable: () => [], isUsingOAuth: () => false,
					find: (provider, id) => catalog.find(m => m.provider === provider && m.id === id),
					getApiKeyAndHeaders: async model => { authCalls.push(model.provider + "/" + model.id); return { ok: true, apiKey: "registry-" + model.provider, headers: {} }; },
				} };
				async function piTools() {
					const tools = [], handlers = {};
					(await import(urls.index)).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on(n,h) { (handlers[n] ??= []).push(h); }, appendEntry() {}, sendMessage() {} });
					for (const h of handlers.session_start ?? []) await h({}, ctx);
					return { tools, handlers, tool: tools.find(t => t.name === "web_search") };
				}
				${body}
			`,
		});
		assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}\n${child.stdout}`);
		return child.stdout;
	} finally { rmSync(root, { recursive: true, force: true }); }
}

for (const provider of ["openai", "xai", "mistral", "gemini"]) {
	test(`${provider}: override wins, accepts IDs absent from registry, and does not leak into later/concurrent calls`, () => {
		scenario(`
			const { search } = await import(urls["gemini-search"]);
			const provider = ${JSON.stringify(provider)};
			const results = await Promise.all([" Exact-Server-ID ", "Other-ID", undefined].map(model => search("q", { provider, model, extensionContext: ctx })));
			assert.equal(results[0].requestedModel, "Exact-Server-ID");
			assert.equal(results[0].sentModel, "Exact-Server-ID");
			assert.equal(results[0].returnedModel, "Exact-Server-ID-reported");
			assert.equal(results[1].sentModel, "Other-ID");
			assert.equal(results[2].requestedModel, undefined);
			await search("later", { provider, extensionContext: ctx });
			const sent = requests.map(r => r.body.model ?? decodeURIComponent(r.url.match(/models\\/(.*):generateContent/)[1]));
			assert.deepEqual(sent, ["Exact-Server-ID", "Other-ID", "configured-" + provider, "configured-" + provider]);
			assert.equal(ctx.model, mainModel);
			assert.deepEqual(JSON.parse(readFileSync(root + "/web-search.json", "utf8")).openaiSearchModel, "configured-openai");
			if (provider === "openai") assert.ok(authCalls.every(s => s === "openai/gpt-6-luna"));
			if (provider === "xai") assert.ok(authCalls.every(s => s === "xai/grok-4.5"));
		`, { browser: true });
	});

	for (const flag of [{ status: 400 }, { status: 401 }, { status: 403 }, { status: 429 }, { network: true }, { empty: true }]) {
		test(`${provider}: ${JSON.stringify(flag)} is a visible error with no substitution`, () => {
			scenario(`
				const { search } = await import(urls["gemini-search"]);
				await assert.rejects(search("q", { provider: ${JSON.stringify(provider)}, model: "Chosen-Model" }), err => {
					assert.match(err.message, /Chosen-Model/);
					assert.match(err.message, /${provider}/);
					assert.doesNotMatch(err.message, /test-${provider}-secret/);
					assert.equal(err.requestedModel, "Chosen-Model");
					return true;
				});
				assert.equal(requests.length, 1);
				assert.equal(browserChecks, 0);
				assert.equal(browserQueries, 0);
			`, { flags: flag, browser: true, config: { searchRouting: { providers: [provider, "brave"], fallbackOn: ["unsupported", "transient", "quota", "network", "invalid-response"] }, braveApiKey: "brave-key" } });
		});
	}

	test(`${provider}: missing auth never sends a request or falls back`, () => {
		scenario(`
			const { search } = await import(urls["gemini-search"]);
			await assert.rejects(search("q", { provider: ${JSON.stringify(provider)}, model: "Chosen-Model" }), /Chosen-Model/);
			assert.equal(requests.length, 0);
			assert.equal(browserChecks, 0);
		`, { browser: true, config: { openaiApiKey: undefined, xaiApiKey: undefined, mistralApiKey: undefined, geminiApiKey: undefined } });
	});
}

test("invalid argument matrix fails before auth/workflow/bootstrap/requests", () => {
	scenario(`
		const entries = [
			{ model: "chosen" }, { provider: "auto", model: "chosen" }, { provider: "all", model: "chosen" },
			{ provider: ["openai"], model: "chosen" }, { provider: ["openai", "gemini"], model: "chosen" },
			{ provider: "brave", model: "chosen" }, { provider: "perplexity", model: "chosen" }, { provider: "bogus", model: "chosen" },
			...["", "  ", null, 3, false, [], {}].map(model => ({ provider: "openai", model })),
		];
		const { search } = await import(urls["gemini-search"]);
		const { createStandaloneWebToolCore } = await import(urls["web-tool-core"]);
		const { tool } = await piTools();
		ctx.modelRegistry = new Proxy({}, { get() { throw new Error("auth must not run"); } });
		for (const entry of entries) {
			const params = { query: "q", ...entry };
			for (const [label, fn] of [
				["dispatch", () => search("q", { ...params, extensionContext: ctx })],
				["programmatic", () => createStandaloneWebToolCore().webSearch(params)],
				...["none", "auto-summary", "summary-review"].map(workflow => [workflow, () => tool.execute("invalid", { ...params, workflow }, undefined, undefined, ctx)]),
			]) await assert.rejects(fn(), err => {
				assert.match(err.message, /model/);
				assert.doesNotMatch(err.message, /auth must not run/);
				return true;
			}, label + ": " + JSON.stringify(entry));
			assert.equal(requests.length, 0, JSON.stringify(entry));
			assert.equal(authCalls.length, 0, JSON.stringify(entry));
		}
	`, { config: { provider: "openai" } });
});

test("override respects provider allowlist and rejects providerFromConfig", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		await assert.rejects(search("q", { provider: "openai", model: "chosen", extensionContext: ctx }), /disabled provider/);
		await assert.rejects(search("q", { provider: "mistral", providerFromConfig: true, model: "chosen" }), /explicit single provider/);
		assert.equal(authCalls.length, 0); assert.equal(requests.length, 0);
	`, { config: { webSearch: { allowedProviders: ["mistral"] } } });
});

test("direct backend callers also reject malformed models before credentials", () => {
	scenario(`
		const functions = [
			(await import(urls["openai-search"])).searchWithOpenAI,
			(await import(urls["xai-search"])).searchWithXai,
			(await import(urls["mistral-search"])).searchWithMistral,
		];
		for (const fn of functions) await assert.rejects(fn("q", { model: false }, ctx), /model must be a non-empty string/);
		assert.equal(requests.length, 0); assert.equal(authCalls.length, 0);
	`);
});

test("OpenAI alpha/search honors the override without changing endpoint/auth headers", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		const result = await search("q", { provider: "openai", model: "Alpha-Model", extensionContext: ctx });
		assert.equal(requests[0].url, "https://api.openai.com/v1/alpha/search");
		assert.equal(requests[0].body.model, "Alpha-Model");
		assert.equal(requests[0].headers.authorization, "Bearer registry-openai");
		assert.equal(result.sentModel, "Alpha-Model");
	`, { config: { openaiUseAlphaSearch: true } });
});

test("OpenAI overrides keep credential order and custom-base-url safeguards", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		catalog[0].baseUrl = "https://custom.example/v1";
		await assert.rejects(search("q", { provider: "openai", model: "Not-In-Catalog", extensionContext: ctx }), /custom baseUrl/);
		assert.deepEqual(authCalls, ["openai/gpt-6-luna"]);
		assert.equal(requests.length, 0);
	`);
});

test("xAI overrides preserve hosted tools and custom-endpoint configured-key policy", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		await search("q", { provider: "xai", model: "X-Model", extensionContext: ctx });
		assert.equal(requests[0].url, "https://relay.example/responses");
		assert.equal(requests[0].headers.authorization, "Bearer test-xai-secret");
		assert.deepEqual(requests[0].body.tools, [{ type: "web_search" }, { type: "x_search" }]);
		assert.equal(authCalls.length, 0);
	`, { config: { xaiResponsesUrl: "https://relay.example/responses", xaiSearchTools: ["web_search", "x_search"] } });
});

test("Mistral overrides preserve premium hosted tool configuration", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		await search("q", { provider: "mistral", model: "M-Model" });
		assert.deepEqual(requests[0].body.tools, [{ type: "web_search_premium" }]);
	`, { config: { mistralSearchTool: "web_search_premium" } });
});

test("Gemini without override retains API-to-browser fallback", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		const result = await search("q", { provider: "gemini" });
		assert.match(result.answer, /Browser answer/);
		assert.equal(browserQueries, 1);
		assert.equal(result.sentModel, undefined);
	`, { browser: true, flags: { status: 500 } });
});

test("Gemini override keeps gateway auth and safely encodes its model path segment", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		await search("q", { provider: "gemini", model: "Exact/Model?foo#bar" });
		assert.ok(requests[0].url.endsWith("/models/Exact%2FModel%3Ffoo%23bar:generateContent"));
		assert.equal(requests[0].headers["cf-aig-authorization"], "Bearer gateway-token");
	`, { config: { geminiApiKey: undefined }, env: { GOOGLE_GEMINI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio", CLOUDFLARE_API_KEY: "gateway-token" } });
});

test("Gemini override retains ADC authentication and Vertex model URL", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		const result = await search("q", { provider: "gemini", model: "Vertex-Model" });
		assert.ok(requests.at(-1).url.endsWith("/projects/test-project/locations/global/publishers/google/models/Vertex-Model:generateContent"));
		assert.equal(requests.at(-1).headers.authorization, "Bearer adc-access-token");
		assert.equal(result.sentModel, "Vertex-Model");
	`, { adc: true, config: { geminiAuth: "adc", geminiProject: "test-project", geminiLocation: "global", geminiApiKey: undefined } });
});

for (const workflow of ["none", "auto-summary", "nested"]) {
	test(`${workflow}: Pi batch forwarding, structured schema, storage/retrieval, and independent summary model`, () => {
		scenario(`
			const { tool, handlers } = await piTools();
			const { Value } = await import("typebox/value");
			const workflow = ${JSON.stringify(workflow)};
			const summaryModel = { ...mainModel, id: "summary-only", api: "anthropic-messages" };
			const summaryCalls = [];
			if (workflow === "auto-summary") {
				catalog.push(summaryModel);
				ctx.modelRegistry.getAvailable = () => [summaryModel];
				ctx.modelRegistry.complete = async selected => {
					summaryCalls.push(selected);
					return { stopReason: "stop", content: [{ type: "text", text: "Independent model summary" }] };
				};
			}
			if (workflow === "nested") for (const h of handlers.tool_call ?? []) h({ toolName: "web_search", toolCallId: "call", parentToolCallId: "script" }, ctx);
			const result = await tool.execute("call", { queries: ["one", "two"], provider: "openai", model: "Chosen", ...(workflow !== "nested" ? { workflow } : {}) }, undefined, undefined, ctx);
			assert.notEqual(result.isError, true);
			assert.ok(Value.Check(tool.outputSchema, result.structuredContent));
			assert.equal(requests.length, 2);
			assert.ok(requests.every(r => r.body.model === "Chosen"));
			const { getResult } = await import(urls.storage);
			const { createStandaloneWebToolCore } = await import(urls["web-tool-core"]);
			const stored = getResult(result.details.searchId);
			assert.equal(stored.queries[1].sentModel, "Chosen");
			assert.equal(result.structuredContent.queries[1].returnedModel, "Chosen-reported");
			assert.equal(result.details.queryProviders[1].requestedModel, "Chosen");
			const page = await createStandaloneWebToolCore().getSearchContent({ responseId: stored.id, queryIndex: 1 });
			assert.match(page.content[0].text, /sent: Chosen/);
			assert.equal(page.details.returnedModel, "Chosen-reported");
			const { deleteResult, loadSessionResults } = await import(urls.storage);
			const journal = JSON.parse(JSON.stringify(stored));
			deleteResult(stored.id);
			loadSessionResults({ sessionManager: { getBranch: () => [{ type: "custom", customType: "web-search-results", data: journal }] } });
			assert.equal(getResult(stored.id).queries[1].returnedModel, "Chosen-reported");
			if (workflow === "auto-summary") {
				assert.deepEqual(summaryCalls, [summaryModel]);
				assert.equal(result.details.summary.model, "anthropic/summary-only");
				assert.equal(result.details.summary.fallbackUsed, false);
				assert.equal(result.details.summary.phase, "summary-model");
				assert.equal(result.details.summary.text, "Independent model summary");
			} else assert.deepEqual(summaryCalls, []);
			assert.equal(ctx.model, mainModel);
		`, { config: { workflow: workflow === "nested" ? "summary-review" : "none", summaryModel: "anthropic/summary-only" } });
	});
}

test("failed Pi queries retain redacted model/provider diagnostics, isError and stored metadata", () => {
	scenario(`
		const { tool } = await piTools();
		const result = await tool.execute("failure", { query: "q", provider: "openai", model: "Bad-Model", workflow: "none" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /openai.*Bad-Model/);
		assert.doesNotMatch(result.content[0].text, /test-openai-secret/);
		const q = result.structuredContent.queries[0];
		assert.equal(q.provider, "openai"); assert.equal(q.requestedModel, "Bad-Model"); assert.equal(q.sentModel, "Bad-Model");
		assert.equal(q.returnedModel, undefined);
		const { getResult } = await import(urls.storage);
		assert.equal(getResult(result.details.searchId).queries[0].requestedModel, "Bad-Model");
	`, { flags: { status: 400 } });
});

test("request-only diagnostics do not invent a server-returned model; old records remain readable", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		const result = await search("q", { provider: "openai", model: "Requested" });
		assert.equal(result.returnedModel, undefined);
		const { storeResult } = await import(urls.storage);
		storeResult("old-record", { id: "old-record", type: "search", timestamp: Date.now(), queries: [{ query: "old", answer: "Old answer", results: [], error: null, provider: "openai" }] });
		const { createStandaloneWebToolCore } = await import(urls["web-tool-core"]);
		const old = await createStandaloneWebToolCore().getSearchContent({ responseId: "old-record", queryIndex: 0 });
		assert.match(old.content[0].text, /Old answer/); assert.doesNotMatch(old.content[0].text, /Search model/);
	`, { flags: { noReturnedModel: true } });
	assert.equal(formatSearchModel({ requestedModel: "same", sentModel: "same", returnedModel: "same" }), "sent: same");
	assert.equal(formatSearchModel({ requestedModel: "chosen" }), "requested: chosen");
});

for (const provider of ["openai", "xai", "mistral", "gemini"]) {
	test(`${provider}: cancellation does not start another query/provider`, () => {
		scenario(`
			const { search } = await import(urls["gemini-search"]);
			await assert.rejects(search("q", { provider: ${JSON.stringify(provider)}, model: "Chosen", signal: AbortSignal.abort() }), /abort/i);
			assert.equal(requests.length, 0);
			await assert.rejects(search("q", { provider: ${JSON.stringify(provider)}, model: "Chosen" }), /abort/i);
			const { createStandaloneWebToolCore } = await import(urls["web-tool-core"]);
			await assert.rejects(createStandaloneWebToolCore().webSearch({ query: "q", provider: ${JSON.stringify(provider)}, model: "abort-ID" }), { name: "AbortError" });
			assert.equal(requests.length, 2); assert.equal(browserQueries, 0);
		`, { flags: { abort: true }, browser: true });
	});
}

test("cancellation after a provider response cannot return a successful override result", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		const mockFetch = globalThis.fetch;
		for (const provider of ["openai", "xai", "mistral", "gemini"]) {
			const c = new AbortController();
			globalThis.fetch = async (...args) => { const res = await mockFetch(...args); c.abort(); return res; };
			await assert.rejects(search("q", { provider, model: "Chosen", signal: c.signal }), /abort/i);
		}
		assert.equal(requests.length, 4);
	`);
});

test("programmatic shared core stores override auth failures instead of dropping model diagnostics", () => {
	scenario(`
		const { createStandaloneWebToolCore } = await import(urls["web-tool-core"]);
		const result = await createStandaloneWebToolCore().webSearch({ query: "q", provider: "openai", model: "abort-ID" });
		assert.equal(result.isError, true);
		assert.equal(result.structuredContent.queries[0].requestedModel, "abort-ID");
		assert.equal(result.structuredContent.queries[0].sentModel, undefined);
		assert.equal(requests.length, 0);
	`, { config: { openaiApiKey: undefined } });
});

test("model IDs containing abort preserve backend errors and successful queries in a mixed batch", () => {
	scenario(`
		const mockFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => init.body.includes("rejected-query")
			? new Response("invalid model abort-ID", { status: 400 }) : mockFetch(url, init);
		const { tool } = await piTools();
		const result = await tool.execute("mixed", { queries: ["rejected-query", "successful-query"], provider: "openai", model: "abort-ID", workflow: "none" });
		assert.notEqual(result.isError, true);
		assert.equal(result.details.successfulQueries, 1);
		const [failed, success] = result.structuredContent.queries;
		assert.match(failed.error, /invalid model/);
		assert.equal(failed.requestedModel, "abort-ID");
		assert.equal(failed.sentModel, "abort-ID");
		assert.equal(success.error, null);
		assert.equal(success.sentModel, "abort-ID");
	`);
});

test("Mistral endpoint preflight errors retain requested model without claiming a sent model", () => {
	scenario(`
		const { createStandaloneWebToolCore } = await import(urls["web-tool-core"]);
		const result = await createStandaloneWebToolCore().webSearch({ query: "q", provider: "mistral", model: "Unsent-Model" });
		assert.equal(result.isError, true);
		const failed = result.structuredContent.queries[0];
		assert.match(failed.error, /absolute HTTPS URL/);
		assert.equal(failed.requestedModel, "Unsent-Model");
		assert.equal(failed.sentModel, undefined);
		assert.equal(result.details.queryProviders[0].sentModel, undefined);
		assert.equal(requests.length, 0);
	`, { config: { mistralSearchBaseUrl: "http://relay.example" } });
});

test("public MCP and source_check schemas do not gain search model overrides", () => {
	scenario(`
		const { MCP_TOOL_DEFINITIONS, validateMcpToolArguments } = await import(urls["mcp-tool-definitions"]);
		const search = MCP_TOOL_DEFINITIONS.find(t => t.name === "web_search");
		assert.ok(validateMcpToolArguments(search, { query: "q", provider: "openai", model: "Chosen" }).length);
		const { tools } = await piTools();
		assert.equal(tools.find(t => t.name === "source_check").parameters.properties.model, undefined);
	`);
});

// Exercise actual curator callbacks over localhost, including default-provider
// changes and one-off "Also try" searches. No browser is launched.
test("curator binds overrides to their original provider, allows switches, and preserves metadata without config writes", () => {
	scenario(`
		const before = readFileSync(root + "/web-search.json", "utf8");
		const { tool } = await piTools();
		const c = new AbortController();
		let reveal;
		const ready = new Promise(r => { reveal = r; });
		const execution = tool.execute("curator", { query: "initial", provider: "openai", model: "Original-Model", workflow: "summary-review" }, c.signal, update => {
			if (update.details?.curatorUrl) reveal(update.details.curatorUrl);
		}, ctx);
		try {
			const url = await ready;
			const html = await (await nativeFetch(url)).text();
			assert.match(html, /"searchModelOverride":\\{"provider":"openai","model":"Original-Model"\\}/);
			assert.match(html, /data-provider="mistral"/);
			const sessionToken = new URL(url).searchParams.get("session");
			const post = async (path, args) => (await nativeFetch(new URL(path, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: sessionToken, ...args }) })).json();
			const other = await post("/search", { query: "other", provider: "mistral" });
			assert.equal(other.provider, "mistral", JSON.stringify(other)); assert.equal(other.requestedModel, undefined);
			await post("/provider", { provider: "mistral" });
			await new Promise(r => setTimeout(r, 10));
			await post("/search", { query: "default-other" });
			const all = await post("/search", { query: "all-defaults", provider: "all" });
			assert.deepEqual(all.entries.map(entry => entry.provider), ["openai"]);
			assert.equal(all.requestedModel, undefined);
			assert.equal(all.sentModel, undefined);
			assert.equal(requests.at(-1).body.model, "configured-openai");
			await post("/provider", { provider: "openai" });
			await new Promise(r => setTimeout(r, 10));
			const back = await post("/search", { query: "back" });
			assert.equal(back.sentModel, "Original-Model");
			assert.equal(back.returnedModel, "Original-Model-reported");
			const models = requests.map(r => r.body.model);
			assert.deepEqual(models, ["Original-Model", "configured-mistral", "configured-mistral", "configured-openai", "Original-Model"]);
			assert.equal(readFileSync(root + "/web-search.json", "utf8"), before);
			const done = await post("/submit", { selected: [0, 1, 2, 3, 4], rawResults: true });
			assert.equal(done.ok, true);
			const result = await execution;
			assert.equal(result.structuredContent.queries[0].sentModel, "Original-Model");
			assert.equal(result.structuredContent.queries.at(-1).sentModel, "Original-Model");
		} finally { c.abort(); await execution; }
	`, { config: { webSearch: { allowedProviders: ["openai", "mistral"] } } });
});

test("curator keeps unavailable explicit selection instead of displaying/substituting another provider", () => {
	scenario(`
		ctx.modelRegistry.getAll = () => [];
		const { tool } = await piTools();
		const c = new AbortController(); let reveal;
		const ready = new Promise(r => { reveal = r; });
		const execution = tool.execute("unavailable", { query: "q", provider: "openai", model: "Missing-Model", workflow: "summary-review" }, c.signal, update => { if (update.details?.curatorUrl) reveal(update.details.curatorUrl); }, ctx);
		try {
			const html = await (await nativeFetch(await ready)).text();
			assert.match(html, /"defaultProvider":"openai"/);
			assert.equal(requests.length, 0);
		} finally { c.abort(); const result = await execution; assert.match(JSON.stringify(result.details), /Missing-Model/); }
	`, { config: { openaiApiKey: undefined, webSearch: { allowedProviders: ["openai", "mistral"] } } });
});

test("curator script includes compact model notice and safely embeds model IDs", async () => {
	const { generateCuratorPage } = await import("../curator-page.ts");
	const model = '</script><script>alert("model")</script>\u2028';
	const html = generateCuratorPage([], "token", 60, { openai: true }, "openai", "openai", [], null, { provider: "openai", model });
	assert.ok(!html.includes(model));
	const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
	assert.doesNotThrow(() => new Function(script));
	assert.match(script, /notice\.textContent = currentProvider === override\.provider/);
	assert.match(script, /searchModelLabel\(data\)/);
});

test("parallel curator sessions retain independent model bindings after one is cancelled", () => {
	scenario(`
		const { tool } = await piTools();
		function start(id, model) {
			const c = new AbortController(); let reveal;
			const ready = new Promise(r => { reveal = r; });
			const execution = tool.execute(id, { query: id, provider: "openai", model, workflow: "summary-review" }, c.signal, u => { if (u.details?.curatorUrl) reveal(u.details.curatorUrl); }, ctx);
			return { c, ready, execution };
		}
		const a = start("parallel-a", "Model-A"), b = start("parallel-b", "Model-B");
		try {
			const [urlA, urlB] = await Promise.all([a.ready, b.ready]);
			assert.notEqual(urlA, urlB);
			a.c.abort();
			const cancelled = await a.execution;
			assert.match(JSON.stringify(cancelled.details.cancelledQueries), /Model-A/);
			assert.doesNotMatch(JSON.stringify(cancelled.details.cancelledQueries), /Model-B/);
			const response = await (await nativeFetch(new URL("/search", urlB), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(urlB).searchParams.get("session"), query: "still-b" }) })).json();
			assert.equal(response.sentModel, "Model-B");
			assert.equal(requests.at(-1).body.model, "Model-B");
		} finally { a.c.abort(); b.c.abort(); await Promise.all([a.execution, b.execution]); }
	`, { config: { webSearch: { allowedProviders: ["openai"] } } });
});

test("curator idle timeout preserves model metadata in returned/stored results", () => {
	scenario(`
		const { tool } = await piTools();
		const c = new AbortController(); let reveal;
		const ready = new Promise(r => { reveal = r; });
		const execution = tool.execute("timeout", { query: "q", provider: "openai", model: "Timeout-Model", workflow: "summary-review" }, c.signal, update => {
			if (update.details?.phase === "curating") reveal(update.details.curatorUrl);
		}, ctx);
		try {
			const url = await ready;
			await nativeFetch(url);
			const response = await nativeFetch(new URL("/heartbeat", url), {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: new URL(url).searchParams.get("session"), idleMs: 6000, timeoutSec: 5 }),
			});
			assert.equal(response.status, 200);
			const result = await execution;
			assert.equal(result.structuredContent.queries[0].sentModel, "Timeout-Model");
			const { getResult } = await import(urls.storage);
			assert.equal(getResult(result.details.searchId).queries[0].requestedModel, "Timeout-Model");
			assert.equal(ctx.model, mainModel);
		} finally { c.abort(); await execution; }
	`, { config: { curatorTimeoutSeconds: 5, webSearch: { allowedProviders: ["openai"] } } });
});

test("Gemini curator override never inspects browser credentials, even without API auth", () => {
	scenario(`
		const { tool } = await piTools();
		const c = new AbortController(); let reveal;
		const ready = new Promise(r => { reveal = r; });
		const execution = tool.execute("gemini-curator", { query: "q", provider: "gemini", model: "API-Only", workflow: "summary-review" }, c.signal, u => { if (u.details?.curatorUrl) reveal(u.details.curatorUrl); }, ctx);
		try {
			const html = await (await nativeFetch(await ready)).text();
			assert.match(html, /"defaultProvider":"gemini"/);
			assert.equal(browserChecks, 0); assert.equal(browserQueries, 0); assert.equal(requests.length, 0);
		} finally { c.abort(); await execution; }
	`, { browser: true, config: { geminiApiKey: undefined, webSearch: { allowedProviders: ["gemini"] } } });
});

test("explicit models take precedence over invalid standing model settings without mutating them", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		for (const provider of ["openai", "xai", "mistral", "gemini"]) {
			const result = await search("q", { provider, model: "Valid-ID" });
			assert.equal(result.sentModel, "Valid-ID");
		}
		assert.equal(JSON.parse(readFileSync(root + "/web-search.json", "utf8")).openaiSearchModel, false);
	`, { config: { openaiSearchModel: false, xaiSearchModel: false, mistralSearchModel: false, searchModel: false } });
});

test("OpenAI alpha override failures do not retry Responses or configured fallback providers", () => {
	scenario(`
		const { search } = await import(urls["gemini-search"]);
		await assert.rejects(search("q", { provider: "openai", model: "Alpha-ID" }), /Alpha-ID/);
		assert.equal(requests.length, 1); assert.match(requests[0].url, /alpha/);
	`, { flags: { status: 404 }, config: { openaiUseAlphaSearch: true, searchRouting: { providers: ["openai", "brave"], fallbackOn: ["unsupported"] } } });
});
