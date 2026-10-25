import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../openai-search.ts", import.meta.url).href;
const routingUrl = new URL("../gemini-search.ts", import.meta.url).href;
const indexUrl = new URL("../index.ts", import.meta.url).href;
const storageUrl = new URL("../storage.ts", import.meta.url).href;
const source = (url = "https://example.com/a", title = "Source", snippet = "Evidence") => ({ type: "text_result", url, title, snippet });
const payload = { output: "Plain search output", results: [source()] };
const legacyPayload = { output: [
	{ type: "web_search_call" },
	{ type: "message", content: [{ type: "output_text", text: "Responses answer" }] },
] };

async function runScenario(t, scenario = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-openai-alpha-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({
		openaiApiKey: "alpha-test-key",
		openaiUseAlphaSearch: true,
		...scenario.config,
	}));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "", TAVILY_API_KEY: "" },
		input: `
			const scenario = ${JSON.stringify({ payload, ...scenario })};
			const requests = [];
			const authProviders = [];
			const timeoutValues = [];
			const originalTimeout = AbortSignal.timeout;
			AbortSignal.timeout = (ms) => {
				timeoutValues.push(ms);
				if (scenario.hang === "timeout" || scenario.bodyHang === "timeout") {
					const c = new AbortController();
					setTimeout(() => c.abort(new DOMException("Timed out", "TimeoutError")), 20);
					return c.signal;
				}
				return originalTimeout(ms);
			};
			globalThis.fetch = async (url, init) => {
				init.signal?.throwIfAborted();
				requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
				if (String(url).includes("api.tavily.com")) return Response.json({ results: [{ title: "Fallback", url: "https://fallback.example/a", content: "Fallback evidence" }] });
				if (scenario.hang) return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
				if (scenario.networkError) throw new TypeError("fetch failed");
				if (scenario.bodyHang) return { ok: true, status: 200, text() {
					if (scenario.bodyHang === "abort") setTimeout(() => c.abort(), 20);
					return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
				} };
				return new Response(scenario.raw ?? JSON.stringify(scenario.payload), { status: scenario.status ?? 200, headers: { "Content-Type": "application/json" } });
			};
			const model = { id: "gpt-5.6-luna", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", ...scenario.model };
			if (scenario.missingBaseUrl) delete model.baseUrl;
			const ctx = scenario.registry || scenario.current ? { model, modelRegistry: {
				getAll: () => scenario.models ?? [model],
				getApiKeyAndHeaders: async (selected) => {
					authProviders.push(selected.provider);
					return scenario.authByProvider?.[selected.provider] ?? { ok: true, apiKey: scenario.key ?? "registry-test-key", headers: scenario.headers ?? {}, ...(scenario.authBaseUrl ? { baseUrl: scenario.authBaseUrl } : {}) };
				},
			} } : undefined;
			const c = new AbortController();
			if (scenario.preAbort) c.abort();
			if (scenario.hang === "abort") setTimeout(() => c.abort(), 100);
			const options = { ...scenario.options, ...(scenario.preAbort || scenario.hang === "abort" || scenario.bodyHang === "abort" ? { signal: c.signal } : {}) };
			let result, error, name, kind;
			try {
				if (scenario.tool) {
					const tools = [], handlers = new Map();
					const { default: initialize } = await import(${JSON.stringify(indexUrl)});
					initialize({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on(event, handler) { handlers.set(event, handler); }, appendEntry() {}, sendMessage() {} });
					await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
					const search = tools.find(tool => tool.name === "web_search");
					const searched = await search.execute("alpha-tool", { queries: ["test query", "second query"], provider: "openai", workflow: "none", ...scenario.options }, undefined, undefined, ctx);
					const retrieve = tools.find(tool => tool.name === "get_search_content");
					const retrieved = await retrieve.execute("alpha-retrieve", { responseId: searched.details.searchId, queryIndex: 1 });
					const { getResult } = await import(${JSON.stringify(storageUrl)});
					result = { text: searched.content[0].text, searchId: searched.details.searchId, retrieved: retrieved.content[0].text, isError: searched.isError || retrieved.isError || false, storedResults: getResult(searched.details.searchId)?.queries.map(query => query.results) };
				} else if (scenario.route) {
					const { search } = await import(${JSON.stringify(routingUrl)});
					result = await search("test query", { ...options, extensionContext: ctx });
				} else {
					const { searchWithOpenAI, searchWithCurrentModelOpenAI, isOpenAISearchAvailable } = await import(${JSON.stringify(moduleUrl)});
					const search = scenario.current ? searchWithCurrentModelOpenAI : searchWithOpenAI;
					if (scenario.availability) result = await isOpenAISearchAvailable(ctx);
					else for (let i = 0; i < (scenario.calls ?? 1); i++) {
						if (i > 0 && scenario.nextBaseUrl) model.baseUrl = scenario.nextBaseUrl;
						result = await search("test query", options, ctx);
					}
				}
			} catch (err) { error = err.message; name = err.name; kind = err.kind; }
			console.log(JSON.stringify({ requests, authProviders, timeoutValues, result, error, name, kind }));
		`,
	});
	assert.equal(child.status, 0, child.stderr || String(child.error));
	return JSON.parse(child.stdout.trim());
}

for (const flag of [undefined, false]) {
	test(`Responses remains unchanged with alpha flag ${flag}`, async (t) => {
		const out = await runScenario(t, { config: { openaiUseAlphaSearch: flag }, payload: legacyPayload });
		assert.equal(out.error, undefined);
		const request = out.requests[0];
		assert.equal(request.url, "https://api.openai.com/v1/responses");
		assert.equal(request.headers["openai-beta"], "responses=experimental");
		assert.equal(request.body.tools[0].type, "web_search");
		assert.equal(request.body.stream, true);
		assert.equal(request.body.commands, undefined);
		assert.equal(out.result.answer, "Responses answer");
	});
}

test("alpha uses a separate JSON protocol and maps plaintext sources", async (t) => {
	const out = await runScenario(t, { calls: 2, config: { openaiSearchModel: "gpt-5.6-luna" } });
	assert.equal(out.error, undefined);
	const request = out.requests[0];
	assert.equal(request.url, "https://api.openai.com/v1/alpha/search");
	assert.deepEqual(Object.keys(request.body).sort(), ["commands", "id", "model"]);
	assert.match(request.body.id, /^[0-9a-f-]{36}$/);
	assert.notEqual(request.body.id, out.requests[1].body.id);
	assert.equal(request.body.model, "gpt-5.6-luna");
	assert.deepEqual(request.body.commands, { search_query: [{ q: "test query" }] });
	assert.equal(request.headers.authorization, "Bearer alpha-test-key");
	assert.equal(request.headers.accept, "application/json");
	assert.equal(request.headers.originator, "codex_cli_rs");
	assert.equal(request.headers["openai-beta"], undefined);
	assert.deepEqual(out.result, { answer: payload.output, results: [{ title: "Source", url: "https://example.com/a", snippet: "Evidence" }] });
	assert.deepEqual(out.timeoutValues, [60_000, 60_000]);
});

test("alpha preserves explicit gateway origin, port, path prefix and query parameters", async (t) => {
	const out = await runScenario(t, {
		registry: true, model: { provider: "gateway", baseUrl: "http://localhost:8921/api/v4" },
		config: { openaiSearchProviders: ["gateway"], openaiResponsesUrl: "http://localhost:8921/api/v4/responses/?version=1", openaiSearchModel: "custom-search-model" },
		headers: { "X-Gateway": "keep", authorization: "stale", "OpenAI-Beta": "responses=experimental", session_id: "private", Conversation_ID: "private", "X-Codex-Beta-Features": "private", "X-Codex-Turn-State": "private", "x-openai-internal-codex-responses-lite": "private", "X-Codex-Turn-Metadata": "keep" },
	});
	assert.equal(out.error, undefined);
	const request = out.requests[0];
	assert.equal(request.url, "http://localhost:8921/api/v4/alpha/search?version=1");
	assert.equal(request.body.model, "custom-search-model");
	assert.equal(request.headers.authorization, "Bearer registry-test-key");
	assert.equal(request.headers["x-gateway"], "keep");
	assert.equal(request.headers["x-codex-turn-metadata"], "keep");
	for (const key of ["openai-beta", "session_id", "conversation_id", "x-codex-beta-features", "x-codex-turn-state", "x-openai-internal-codex-responses-lite"]) assert.equal(request.headers[key], undefined, key);
});

for (const current of [false, true]) {
	test(`alpha keeps Codex endpoint/account selection (current model: ${current})`, async (t) => {
		const key = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
		const out = await runScenario(t, { current, registry: true, key, model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" } });
		assert.equal(out.error, undefined);
		assert.equal(out.requests[0].url, "https://chatgpt.com/backend-api/codex/alpha/search");
		assert.equal(out.requests[0].headers["chatgpt-account-id"], "test-account");
	});
}

test("alpha current-model routing keeps official model and ignores configured gateway/model", async (t) => {
	const out = await runScenario(t, { current: true, config: { openaiResponsesUrl: "http://gateway.invalid/responses", openaiSearchModel: "not-current" } });
	assert.equal(out.error, undefined);
	assert.equal(out.requests[0].url, "https://api.openai.com/v1/alpha/search");
	assert.equal(out.requests[0].body.model, "gpt-5.6-luna");
});

test("alpha does not weaken custom-baseURL credential or current-model guards", async (t) => {
	for (const current of [false, true]) {
		const out = await runScenario(t, { current, registry: true, model: { baseUrl: "https://gateway.invalid/v1" } });
		assert.deepEqual(out.requests, []);
		assert.match(out.error, current ? /not eligible/ : /custom baseUrl/);
	}
});

for (const value of ["true", 1, null, {}]) {
	test(`alpha flag rejects non-boolean ${JSON.stringify(value)}`, async (t) => {
		const out = await runScenario(t, { config: { openaiUseAlphaSearch: value } });
		assert.deepEqual(out.requests, []);
		assert.match(out.error, /openaiUseAlphaSearch.*must be a boolean/);
	});
}

test("alpha rejects endpoints without a responses suffix before sending credentials", async (t) => {
	const out = await runScenario(t, { config: { openaiResponsesUrl: "https://gateway.invalid/v1/chat/completions" } });
	assert.deepEqual(out.requests, []);
	assert.match(out.error, /must.*\/responses/);
});

for (const [recencyFilter, recency] of [["day", 1], ["week", 7], ["month", 30], ["year", 365]]) {
	test(`alpha maps ${recencyFilter} recency and allowed domains`, async (t) => {
		const out = await runScenario(t, { options: { recencyFilter, domainFilter: ["https://www.example.com/path", "www.example.com"] } });
		assert.equal(out.error, undefined);
		assert.deepEqual(out.requests[0].body.commands.search_query, [{ q: "test query", recency, domains: ["www.example.com"] }]);
	});
}

test("alpha rejects excluded domains instead of silently ignoring them", async (t) => {
	const out = await runScenario(t, { options: { domainFilter: ["example.com", "-blocked.example"] } });
	assert.deepEqual(out.requests, []);
	assert.match(out.error, /unsupported.*excluded domains/i);
});

test("alpha ignores malformed/non-text sources, cleans URLs, deduplicates and caps results", async (t) => {
	const out = await runScenario(t, { options: { numResults: 2 }, payload: { output: "  Plaintext  ", results: [
		null, { type: "image_result", url: "https://ignored.example" }, source("javascript:alert(1)"), source("not a URL"),
		source("https://example.com/a?utm_source=openai"), source("https://example.com/a"),
		source("https://example.com/b", "", 42), source("https://example.com/c"),
	] } });
	assert.equal(out.error, undefined);
	assert.deepEqual(out.result, { answer: "Plaintext", results: [
		{ title: "Source", url: "https://example.com/a", snippet: "Evidence" },
		{ title: "https://example.com/b", url: "https://example.com/b", snippet: "" },
	] });
});

for (const tool of [false, true]) {
	test(`alpha defaults to five deduplicated sources when numResults is omitted (tool: ${tool})`, async (t) => {
		const sources = Array.from({ length: 25 }, (_, i) => source(`https://example.com/default-result-${i}`));
		const out = await runScenario(t, { tool, payload: { output: "Keep the plaintext answer", results: [
			null, { type: "image_result", url: "https://ignored.example" }, source("javascript:alert(1)"),
			source("https://example.com/default-result-0?utm_source=openai"), sources[0], ...sources,
		] } });
		assert.equal(out.error, undefined);
		const expectedUrls = sources.slice(0, 5).map(item => item.url);
		if (tool) {
			assert.equal(out.result.isError, false);
			assert.equal(out.result.storedResults.length, 2);
			for (const results of out.result.storedResults) assert.deepEqual(results.map(item => item.url), expectedUrls);
			assert.match(out.result.retrieved, /default-result-4/);
			assert.doesNotMatch(out.result.retrieved, /default-result-5\b/);
		} else {
			assert.equal(out.result.answer, "Keep the plaintext answer");
			assert.deepEqual(out.result.results.map(item => item.url), expectedUrls);
		}
	});
}

test("alpha caps requested source count at 20", async (t) => {
	const out = await runScenario(t, { options: { numResults: 50 }, payload: { results: Array.from({ length: 25 }, (_, i) => source(`https://example.com/${i}`)) } });
	assert.equal(out.error, undefined);
	assert.equal(out.result.results.length, 20);
});

for (const response of [{ output: "Only text" }, { results: [source()] }]) {
	test(`alpha accepts ${response.output ? "plaintext only" : "structured sources only"}`, async (t) => {
		const out = await runScenario(t, { payload: response });
		assert.equal(out.error, undefined);
		assert.ok(out.result.answer || out.result.results.length);
	});
}

for (const raw of ["not JSON", "null", "[]", "{}", '{"encrypted_output":"ciphertext"}', '{"output":[{"type":"web_search_call"}]}']) {
	test(`alpha rejects unusable response ${raw}`, async (t) => {
		const out = await runScenario(t, { raw });
		assert.match(out.error, /invalid JSON|invalid response|no parseable results/i);
		assert.equal(out.result, undefined);
	});
}

const route = { providers: ["openai", "tavily"], fallbackOn: ["unsupported", "transient", "quota", "network", "invalid-response"] };
for (const status of [404, 405, 501, 503, 429]) {
	test(`alpha HTTP ${status} follows configured provider fallback without a Responses retry`, async (t) => {
		const out = await runScenario(t, { route: true, status, raw: "Endpoint error", config: { tavilyApiKey: "tavily-test-key", searchRouting: route } });
		assert.equal(out.error, undefined);
		assert.equal(out.result.provider, "tavily");
		assert.equal(out.requests.length, 2);
		assert.ok(out.requests[0].url.endsWith("/alpha/search"));
		assert.ok(out.requests[1].url.includes("api.tavily.com"));
	});
}

for (const scenario of [{ options: { domainFilter: ["-example.com"] } }, { raw: "bad JSON" }, { networkError: true }]) {
	test(`alpha fallback covers ${scenario.options ? "unsupported filter" : scenario.raw ? "invalid response" : "network error"}`, async (t) => {
		const out = await runScenario(t, { ...scenario, route: true, config: { tavilyApiKey: "tavily-test-key", searchRouting: route } });
		assert.equal(out.error, undefined);
		assert.equal(out.result.provider, "tavily");
	});
}

test("alpha respects fallback policy and keeps HTTP auth errors terminal/redacted", async (t) => {
	for (const status of [401, 403, 404]) {
		const out = await runScenario(t, { route: true, status, raw: "Error alpha-test-key", config: { tavilyApiKey: "tavily-test-key", searchRouting: { ...route, fallbackOn: ["network"] } } });
		assert.equal(out.kind, status === 404 ? "unsupported" : "auth");
		assert.ok(!out.error.includes("alpha-test-key"));
		assert.equal(out.requests.length, 1);
	}
});

test("alpha keeps pre-abort, in-flight cancellation and the existing 60s deadline", async (t) => {
	const before = await runScenario(t, { preAbort: true });
	assert.deepEqual(before.requests, []);
	assert.equal(before.name, "AbortError");
	const during = await runScenario(t, { hang: "abort", route: true, config: { tavilyApiKey: "tavily-test-key", searchRouting: route } });
	assert.equal(during.kind, "aborted");
	assert.ok(during.requests.length <= 1);
	const timeout = await runScenario(t, { hang: "timeout" });
	assert.equal(timeout.name, "TimeoutError");
	assert.deepEqual(timeout.timeoutValues, [60_000]);
});


test("alpha traverses configured current-model routing", async (t) => {
	const out = await runScenario(t, { route: true, current: true, config: { searchRouting: { ...route, useCurrentModel: true } } });
	assert.equal(out.error, undefined);
	assert.equal(out.result.provider, "openai");
	assert.equal(out.requests[0].url, "https://api.openai.com/v1/alpha/search");
	assert.equal(out.requests[0].body.model, "gpt-5.6-luna");
});

test("alpha executes through registered web_search and preserves stored-content retrieval", async (t) => {
	const out = await runScenario(t, { tool: true });
	assert.equal(out.error, undefined);
	assert.equal(out.result.isError, false);
	assert.ok(out.result.searchId);
	assert.match(out.result.text, /Plain search output/);
	assert.match(out.result.retrieved, /Plain search output/);
	assert.match(out.result.retrieved, /example\.com/);
	assert.equal(out.requests.length, 2, "no additional Responses or summary calls");
	assert.deepEqual(out.requests.map(r => r.body.commands.search_query[0].q), ["test query", "second query"]);
	assert.ok(out.requests.every(r => r.url.endsWith("/alpha/search")));
});

for (const bodyHang of ["abort", "timeout"]) {
	test(`alpha keeps ${bodyHang} active during response body consumption`, async (t) => {
		const out = await runScenario(t, { bodyHang });
		assert.equal(out.name, bodyHang === "abort" ? "AbortError" : "TimeoutError");
		assert.equal(out.requests.length, 1);
	});
}

test("alpha caller cancellation takes precedence over unsupported filters", async (t) => {
	const out = await runScenario(t, { preAbort: true, options: { domainFilter: ["-example.com"] } });
	assert.deepEqual(out.requests, []);
	assert.equal(out.name, "AbortError");
});


const providerPaths = [
	["https://gateway.example", "/v1/responses"],
	["https://gateway.example/", "/v1/responses"],
	["https://gateway.example/v1", "/v1/responses"],
	["https://gateway.example/team/v1/", "/team/v1/responses"],
	["https://gateway.example/custom", "/custom/responses"],
	["https://gateway.example/v1/responses", "/v1/responses"],
	["https://gateway.example/v1/responses/", "/v1/responses"],
];
for (const alpha of [false, true]) {
	for (const [baseUrl, path] of providerPaths) {
		test(`provider URL reuse completes ${baseUrl} (alpha: ${alpha})`, async (t) => {
			const out = await runScenario(t, { registry: true, model: { baseUrl }, config: { openaiUseProviderBaseUrl: true, openaiUseAlphaSearch: alpha }, payload: alpha ? payload : legacyPayload });
			assert.equal(out.error, undefined);
			assert.equal(out.requests[0].url, "https://gateway.example" + (alpha ? path.replace(/\/responses$/, "/alpha/search") : path));
			assert.equal(out.requests[0].headers.authorization, "Bearer registry-test-key");
		});
	}
}

const providerCandidates = {
	registry: true,
	models: [
		{ id: "gpt-5.6-luna", provider: "first", api: "openai-responses", baseUrl: "https://first-model.example/v1" },
		{ id: "gpt-5.6-terra", provider: "second", api: "openai-responses", baseUrl: "https://second-model.example/v1" },
	],
	authByProvider: {
		first: { ok: true, apiKey: "first-provider-key", headers: { "X-Selected": "first" } },
		second: { ok: true, apiKey: "second-provider-key", baseUrl: "https://second-auth.example/team/v1", headers: { "X-Selected": "second" } },
	},
	config: { openaiSearchProviders: ["first", "second"], openaiUseProviderBaseUrl: true },
};

for (const alpha of [false, true]) {
	for (const [reason, modelBaseUrl, authBaseUrl] of [
		["missing model URL", undefined, undefined],
		["invalid model URL", "/v1", undefined],
		["invalid auth URL", "https://first-model.example/v1", "invalid"],
	]) {
		test(`provider URL reuse skips ${reason} and keeps the next candidate's credentials (alpha: ${alpha})`, async (t) => {
			const args = {
				...providerCandidates,
				models: [{ ...providerCandidates.models[0], baseUrl: modelBaseUrl }, providerCandidates.models[1]],
				authByProvider: { ...providerCandidates.authByProvider, first: { ...providerCandidates.authByProvider.first, baseUrl: authBaseUrl } },
				config: { ...providerCandidates.config, openaiUseAlphaSearch: alpha },
				payload: alpha ? payload : legacyPayload,
			};
			const out = await runScenario(t, args);
			assert.equal(out.error, undefined);
			assert.deepEqual(out.authProviders, ["first", "second"]);
			assert.equal(out.requests.length, 1);
			assert.equal(out.requests[0].url, "https://second-auth.example/team/v1/" + (alpha ? "alpha/search" : "responses"));
			assert.equal(out.requests[0].headers.authorization, "Bearer second-provider-key");
			assert.equal(out.requests[0].headers["x-selected"], "second");
			assert.equal(out.requests[0].body.model, "gpt-5.6-terra");
			const available = await runScenario(t, { ...args, availability: true });
			assert.equal(available.error, undefined);
			assert.equal(available.result, true);
			assert.deepEqual(available.authProviders, ["first", "second"]);
			assert.deepEqual(available.requests, []);
		});
	}

	test(`provider URL reuse checks all invalid candidates without standalone key fallback (alpha: ${alpha})`, async (t) => {
		const args = {
			...providerCandidates,
			models: [{ ...providerCandidates.models[0], baseUrl: undefined }, providerCandidates.models[1]],
			authByProvider: { ...providerCandidates.authByProvider, second: { ...providerCandidates.authByProvider.second, baseUrl: "ftp://invalid.example/v1" } },
			config: { ...providerCandidates.config, openaiUseAlphaSearch: alpha },
		};
		const out = await runScenario(t, args);
		assert.deepEqual(out.authProviders, ["first", "second"]);
		assert.deepEqual(out.requests, []);
		assert.match(out.error, /openaiUseProviderBaseUrl requires an absolute http\(s\) provider baseUrl/);
		const available = await runScenario(t, { ...args, availability: true });
		assert.equal(available.error, undefined);
		assert.equal(available.result, false);
		assert.deepEqual(available.authProviders, ["first", "second"]);
		assert.deepEqual(available.requests, []);
	});
}

for (const flag of [undefined, false]) {
	test(`provider candidates retain the existing origin guard with URL reuse ${flag}`, async (t) => {
		const out = await runScenario(t, { ...providerCandidates, config: { ...providerCandidates.config, openaiUseProviderBaseUrl: flag } });
		assert.deepEqual(out.authProviders, ["first"]);
		assert.deepEqual(out.requests, []);
		assert.match(out.error, /custom baseUrl/);
	});
}

test("explicit endpoint keeps the first credential candidate even with an invalid provider URL", async (t) => {
	const out = await runScenario(t, {
		...providerCandidates,
		models: [{ ...providerCandidates.models[0], baseUrl: "invalid" }, providerCandidates.models[1]],
		config: { ...providerCandidates.config, openaiResponsesUrl: "https://explicit.example/v1/responses" },
	});
	assert.equal(out.error, undefined);
	assert.deepEqual(out.authProviders, ["first"]);
	assert.equal(out.requests.length, 1);
	assert.equal(out.requests[0].url, "https://explicit.example/v1/alpha/search");
	assert.equal(out.requests[0].headers.authorization, "Bearer first-provider-key");
});

test("provider URL reuse does not retry a failed request with later credential candidates", async (t) => {
	const out = await runScenario(t, { ...providerCandidates, status: 503 });
	assert.deepEqual(out.authProviders, ["first"]);
	assert.equal(out.requests.length, 1);
	assert.equal(out.requests[0].url, "https://first-model.example/v1/alpha/search");
	assert.equal(out.requests[0].headers.authorization, "Bearer first-provider-key");
	assert.match(out.error, /API error 503/);
});

for (const flag of [undefined, false]) {
	test(`provider URL reuse stays off for ${flag}`, async (t) => {
		const out = await runScenario(t, { registry: true, model: { baseUrl: "https://gateway.example/v1" }, config: { openaiUseProviderBaseUrl: flag } });
		assert.deepEqual(out.requests, []);
		assert.match(out.error, /custom baseUrl/);
	});
}

for (const alpha of [false, true]) {
	test(`explicit endpoint ignores provider URL switch entirely (alpha: ${alpha})`, async (t) => {
		for (const flag of [true, false, "ignored", null]) {
			const out = await runScenario(t, { registry: true, model: { baseUrl: "invalid provider URL" }, config: { openaiResponsesUrl: "https://explicit.example/prefix/responses", openaiUseProviderBaseUrl: flag, openaiUseAlphaSearch: alpha }, payload: alpha ? payload : legacyPayload });
			assert.equal(out.error, undefined);
			assert.equal(out.requests[0].url, "https://explicit.example/prefix/" + (alpha ? "alpha/search" : "responses"));
		}
	});
}

test("provider URL reuse prefers auth-resolved origin and preserves port and query", async (t) => {
	const out = await runScenario(t, { registry: true, model: { baseUrl: "https://model.example/v1" }, authBaseUrl: "http://auth.example:8921/team/v1?version=1", config: { openaiUseProviderBaseUrl: true } });
	assert.equal(out.error, undefined);
	assert.equal(out.requests[0].url, "http://auth.example:8921/team/v1/alpha/search?version=1");
});

test("provider URL reuse follows updated model registry URLs without caching the endpoint", async (t) => {
	const out = await runScenario(t, { registry: true, calls: 2, model: { baseUrl: "https://first.example/v1" }, nextBaseUrl: "https://second.example/team", config: { openaiUseProviderBaseUrl: true } });
	assert.equal(out.error, undefined);
	assert.deepEqual(out.requests.map(request => request.url), ["https://first.example/v1/alpha/search", "https://second.example/team/alpha/search"]);
});

for (const value of ["true", 1, null]) {
	test(`provider URL reuse validates ${JSON.stringify(value)} when not overridden`, async (t) => {
		const out = await runScenario(t, { config: { openaiUseProviderBaseUrl: value } });
		assert.deepEqual(out.requests, []);
		assert.match(out.error, /openaiUseProviderBaseUrl.*boolean/);
	});
}

for (const scenario of [
	{},
	{ registry: true, key: "" },
	{ registry: true, missingBaseUrl: true },
	{ registry: true, model: { baseUrl: "" } },
	{ registry: true, model: { baseUrl: "/v1" } },
	{ registry: true, model: { baseUrl: "ftp://gateway.example/v1" } },
	{ registry: true, authBaseUrl: "invalid", model: { baseUrl: "https://model.example/v1" } },
]) {
	test(`provider URL reuse fails closed and reports unavailable: ${JSON.stringify(scenario)}`, async (t) => {
		const args = { ...scenario, config: { openaiUseProviderBaseUrl: true } };
		const out = await runScenario(t, args);
		assert.deepEqual(out.requests, []);
		assert.match(out.error, /configuration.*openaiUseProviderBaseUrl.*baseUrl/i);
		const available = await runScenario(t, { ...args, availability: true });
		assert.equal(available.error, undefined);
		assert.equal(available.result, false);
	});
}

test("provider URL reuse makes a configured gateway available", async (t) => {
	const out = await runScenario(t, { registry: true, availability: true, model: { baseUrl: "https://gateway.example/v1" }, config: { openaiUseProviderBaseUrl: true } });
	assert.equal(out.error, undefined);
	assert.equal(out.result, true);
	assert.deepEqual(out.requests, []);
});

for (const alpha of [false, true]) {
	for (const baseUrl of ["https://chatgpt.com/backend-api", "https://gateway.example/team/v1"]) {
		test(`provider URL reuse preserves Codex metadata without overriding ${baseUrl} (alpha: ${alpha})`, async (t) => {
			const key = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
			const out = await runScenario(t, { registry: true, key, model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl }, config: { openaiUseProviderBaseUrl: true, openaiUseAlphaSearch: alpha }, payload: alpha ? payload : legacyPayload });
			assert.equal(out.error, undefined);
			assert.equal(out.requests[0].url, baseUrl + (baseUrl.includes("chatgpt.com") ? "/codex" : "") + (alpha ? "/alpha/search" : "/responses"));
			assert.equal(out.requests[0].headers["chatgpt-account-id"], "test-account");
		});
	}
}

test("explicit endpoint keeps existing Codex selection when provider URL switch is ignored", async (t) => {
	const out = await runScenario(t, { registry: true, model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://provider.example/v1" }, config: { openaiResponsesUrl: "https://explicit.example/v1/responses", openaiUseProviderBaseUrl: true } });
	assert.equal(out.error, undefined);
	assert.equal(out.requests[0].url, "https://chatgpt.com/backend-api/codex/alpha/search");
});

test("provider URL reuse does not broaden current-model eligibility", async (t) => {
	const rejected = await runScenario(t, { current: true, model: { baseUrl: "https://gateway.example/v1" }, config: { openaiUseProviderBaseUrl: true } });
	assert.deepEqual(rejected.requests, []);
	assert.match(rejected.error, /not eligible/);
	const official = await runScenario(t, { current: true, config: { openaiUseProviderBaseUrl: true } });
	assert.equal(official.error, undefined);
	assert.equal(official.requests[0].url, "https://api.openai.com/v1/alpha/search");
});


for (const endpoint of ["", "not a URL", null]) {
	test(`provider URL reuse cannot rescue invalid explicit endpoint ${JSON.stringify(endpoint)}`, async (t) => {
		const out = await runScenario(t, { registry: true, model: { baseUrl: "https://gateway.example/v1" }, config: { openaiResponsesUrl: endpoint, openaiUseProviderBaseUrl: true } });
		assert.deepEqual(out.requests, []);
		assert.match(out.error, /openaiResponsesUrl.*absolute http/);
	});
}

test("provider URL reuse works through configured provider routing", async (t) => {
	const out = await runScenario(t, { registry: true, route: true, model: { provider: "gateway", baseUrl: "https://gateway.example" }, config: { openaiSearchProviders: ["gateway"], openaiUseProviderBaseUrl: true, searchRouting: route } });
	assert.equal(out.error, undefined);
	assert.equal(out.result.provider, "openai");
	assert.equal(out.requests.length, 1);
	assert.equal(out.requests[0].url, "https://gateway.example/v1/alpha/search");
});

test("provider URL reuse traverses registered web_search and content retrieval", async (t) => {
	const out = await runScenario(t, { registry: true, tool: true, model: { provider: "gateway", baseUrl: "https://gateway.example" }, config: { openaiSearchProviders: ["gateway"], openaiUseProviderBaseUrl: true } });
	assert.equal(out.error, undefined);
	assert.equal(out.result.isError, false);
	assert.match(out.result.retrieved, /Plain search output/);
	assert.equal(out.requests.length, 2);
	assert.ok(out.requests.every(request => request.url === "https://gateway.example/v1/alpha/search"));
});
