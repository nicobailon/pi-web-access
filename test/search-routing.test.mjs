import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const indexModuleUrl = new URL("../index.ts", import.meta.url).href;

async function createConfig(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-search-routing-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "XAI_API_KEY", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("configured routing follows order after a selected network failure and returns the successful provider", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
			if (String(url) === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "Tavily route answer", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("ordered route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.answer, "Tavily route answer");
	assert.deepEqual(output.calls, ["https://api.search.brave.com/res/v1/web/search?q=ordered+route&count=5", "https://api.tavily.com/search"]);
});

test("configured routing fails closed on quota errors not selected by fallbackOn", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.search.brave.com/")) return new Response("quota", { status: 429 });
			if (String(url) === "https://api.tavily.com/search") throw new Error("Tavily must not run");
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("quota route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error), calls }));
		}
	`, {
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /brave search failed \(quota\)/);
	assert.deepEqual(output.calls, ["https://api.search.brave.com/res/v1/web/search?q=quota+route&count=5"]);
});

test("configured routing falls back from Tavily monthly plan exhaustion", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["tavily", "brave"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.tavily.com/search") return new Response("Monthly plan usage limit exceeded", { status: 432 });
			if (String(url).startsWith("https://api.search.brave.com/")) {
				return new Response(JSON.stringify({ web: { results: [{ title: "Brave fallback", url: "https://example.com/brave", description: "Fallback answer" }] } }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("tavily quota route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tavily-test-key",
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "brave");
	assert.equal(output.answer, "Fallback answer\nSource: Brave fallback (https://example.com/brave)");
	assert.deepEqual(output.calls, ["https://api.tavily.com/search", "https://api.search.brave.com/res/v1/web/search?q=tavily+quota+route&count=5"]);
});

test("auth status fails closed even when the response text looks like quota", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.search.brave.com/")) return new Response("quota exceeded", { status: 403 });
			if (String(url) === "https://api.tavily.com/search") throw new Error("Tavily must not run");
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("auth route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error), calls }));
		}
	`, {
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /brave search failed \(auth\)/);
	assert.deepEqual(output.calls, ["https://api.search.brave.com/res/v1/web/search?q=auth+route&count=5"]);
});

test("configured routing falls back from an xAI 403 quota-exhausted response", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["xai", "tavily"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.x.ai/v1/responses") return new Response("quota exhausted", { status: 403 });
			if (String(url) === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "Tavily fallback answer", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("xai quota route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		XAI_API_KEY: "xai-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.answer, "Tavily fallback answer");
	assert.deepEqual(output.calls, ["https://api.x.ai/v1/responses", "https://api.tavily.com/search"]);
});

test("configured routing keeps an ordinary xAI 403 response classified as auth", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["xai", "tavily"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.x.ai/v1/responses") return new Response("invalid API key", { status: 403 });
			if (String(url) === "https://api.tavily.com/search") throw new Error("Tavily must not run");
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("xai auth route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error), calls }));
		}
	`, {
		PI_CODING_AGENT_DIR: home,
		XAI_API_KEY: "xai-test-key",
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /xai search failed \(auth\)/i);
	assert.deepEqual(output.calls, ["https://api.x.ai/v1/responses"]);
});

test("legacy single-provider config takes precedence over searchRouting", async () => {
	const home = await createConfig({
		provider: "perplexity",
		searchRouting: { providers: ["tavily", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.perplexity.ai/chat/completions") {
				return new Response(JSON.stringify({ choices: [{ message: { content: "Perplexity answer" } }], citations: [] }), { status: 200 });
			}
			throw new Error("Routing provider must not run");
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("precedence", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		PERPLEXITY_API_KEY: "perplexity-test-key",
		TAVILY_API_KEY: "tavily-test-key",
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "perplexity",
		calls: ["https://api.perplexity.ai/chat/completions"],
	});
});

test("configured routing accepts SERPdive and detects its availability", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["serpdive"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.serpdive.com/v1/search") {
				return new Response(JSON.stringify({ results: [{ url: "https://serpdive.example/source", title: "SERPdive source", content: "SERPdive content" }] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("serpdive route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		SERPDIVE_API_KEY: "serpdive-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "serpdive");
	assert.match(output.answer, /SERPdive content/);
	assert.deepEqual(output.calls, ["https://api.serpdive.com/v1/search"]);
});

test("configured SERPdive provider remains strict instead of falling back to auto", async () => {
	const home = await createConfig({ provider: "serpdive" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.serpdive.com/v1/search") {
				return new Response(JSON.stringify({ results: [{ url: "https://serpdive.example/source", title: "SERPdive source", content: "configured content" }] }), { status: 200 });
			}
			throw new Error("Auto fallback must not run: " + url);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("configured serpdive", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		SERPDIVE_API_KEY: "serpdive-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "serpdive");
	assert.match(output.answer, /configured content/);
	assert.deepEqual(output.calls, ["https://api.serpdive.com/v1/search"]);
});

test("invalid searchRouting configuration fails loudly", async () => {
	const home = await createConfig({ searchRouting: { providers: ["auto"], fallbackOn: ["network"] } });
	const child = runChild(`
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("invalid route", { provider: "auto" });
			console.log(JSON.stringify({ ok: true }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error) }));
		}
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /searchRouting\.providers .*invalid provider: auto/);
});

test("current-model routing uses the official OpenAI model, auth, headers, and endpoint", async () => {
	const home = await createConfig({
		searchRouting: {
			providers: ["openai", "tavily"],
			useCurrentModel: true,
			fallbackOn: ["unsupported", "transient", "quota", "network", "invalid-response"],
		},
	});
	const child = runChild(`
		let captured = null;
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.openai.com/v1/responses") {
				captured = { body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers)) };
				return new Response(JSON.stringify({ output: [
					{ type: "web_search_call", action: { sources: [{ title: "OpenAI source", url: "https://example.com/source?utm_source=openai" }] } },
					{ type: "message", content: [{ type: "output_text", text: "Hosted answer", annotations: [{ type: "url_citation", url: "https://example.com/source?utm_source=openai", title: "OpenAI source", start_index: 0, end_index: 6 }] }] },
				] }), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Tavily must not run");
		};
		const model = { provider: "openai", api: "openai-responses", id: "gpt-5.6-terra", baseUrl: "https://api.openai.com/v1" };
		const ctx = {
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async (selected) => ({ ok: true, apiKey: selected.id + "-key", headers: { "X-Current-Model": "yes" } }),
			},
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("official hosted search", { provider: "auto", extensionContext: ctx });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, results: result.results, calls, captured }));
	`, {
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tavily-must-not-run",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "openai");
	assert.equal(output.answer, "Hosted answer");
	assert.deepEqual(output.results.map((result) => result.url), ["https://example.com/source"]);
	assert.deepEqual(output.calls, ["https://api.openai.com/v1/responses"]);
	assert.equal(output.captured.body.model, "gpt-5.6-terra");
	assert.equal(output.captured.headers.authorization, "Bearer gpt-5.6-terra-key");
	assert.equal(output.captured.headers["x-current-model"], "yes");
});

test("non-official and non-GPT current models skip automatic Hosted Search", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["openai", "tavily"], useCurrentModel: true, fallbackOn: ["unsupported", "network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.tavily.com/search") return new Response(JSON.stringify({ answer: "Tavily answer", results: [] }), { status: 200 });
			throw new Error("Hosted OpenAI must not run: " + target);
		};
		const models = [
			{ provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://ai.feei.cn/v1" },
			{ provider: "openai", api: "openai-responses", id: "grok-4.6", baseUrl: "https://api.openai.com/v1" },
		];
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const results = [];
		for (const model of models) {
			results.push((await search(model.id, {
				provider: "auto",
				extensionContext: { model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "must-not-be-used" }) } },
			})).provider);
		}
		console.log(JSON.stringify({ results, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.results, ["tavily", "tavily"]);
	assert.equal(output.calls.length, 2);
	assert.ok(output.calls.every((url) => url === "https://api.tavily.com/search"));
});

test("Codex current models use the official Codex Responses search endpoint", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["openai", "tavily"], useCurrentModel: true, fallbackOn: ["unsupported", "network"] },
	});
	const child = runChild(`
		let captured = null;
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			calls.push(target);
			if (target !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("Tavily must not run: " + target);
			captured = { body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers)) };
			return new Response(JSON.stringify({ output: [
				{ type: "web_search_call", action: { sources: [{ title: "Codex source", url: "https://example.com/codex" }] } },
				{ type: "message", content: [{ type: "output_text", text: "Codex hosted answer" }] },
			] }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" };
		const ctx = {
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async (selected) => ({ ok: true, apiKey: selected.id + "-key", headers: { "X-Current-Model": "yes" } }),
			},
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("official Codex hosted search", { provider: "auto", extensionContext: ctx });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls, captured }));
	`, {
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tavily-must-not-run",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "openai");
	assert.equal(output.answer, "Codex hosted answer");
	assert.deepEqual(output.calls, ["https://chatgpt.com/backend-api/codex/responses"]);
	assert.equal(output.captured.body.model, "gpt-5.6-sol");
	assert.equal(output.captured.headers.authorization, "Bearer gpt-5.6-sol-key");
	assert.equal(output.captured.headers["x-current-model"], "yes");
});

test("explicit OpenAI provider bypasses current-model restrictions", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["openai", "tavily"], useCurrentModel: true, fallbackOn: ["unsupported", "network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.openai.com/v1/responses") {
				return new Response(JSON.stringify({ output: [
					{ type: "web_search_call", action: { sources: [] } },
					{ type: "message", content: [{ type: "output_text", text: "Explicit OpenAI answer" }] },
				] }), { status: 200 });
			}
			throw new Error("Tavily must not run");
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("explicit provider", {
			provider: "openai",
			extensionContext: { model: { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://ai.feei.cn/v1" }, modelRegistry: { getAll: () => [] } },
		});
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		OPENAI_API_KEY: "explicit-openai-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "openai",
		answer: "Explicit OpenAI answer",
		calls: ["https://api.openai.com/v1/responses"],
	});
});

test("unsupported Hosted Search errors fall back to Tavily", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["openai", "tavily"], useCurrentModel: true, fallbackOn: ["unsupported"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.openai.com/v1/responses") return new Response("This model does not support web_search", { status: 400 });
			if (target === "https://api.tavily.com/search") return new Response(JSON.stringify({ answer: "Fallback answer", results: [] }), { status: 200 });
			throw new Error("Unexpected fetch: " + target);
		};
		const ctx = { model: { provider: "openai", api: "openai-responses", id: "gpt-5.6", baseUrl: "https://api.openai.com/v1" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "hosted-key" }) } };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("unsupported hosted search", { provider: "auto", extensionContext: ctx });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "tavily",
		answer: "Fallback answer",
		calls: ["https://api.openai.com/v1/responses", "https://api.tavily.com/search"],
	});
});

test("Hosted authentication errors do not silently fall back", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["openai", "tavily"], useCurrentModel: true, fallbackOn: ["unsupported", "transient", "quota", "network", "invalid-response"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url) === "https://api.openai.com/v1/responses") return new Response("invalid API key", { status: 401 });
			throw new Error("Tavily must not run");
		};
		const ctx = { model: { provider: "openai", api: "openai-responses", id: "gpt-5.6", baseUrl: "https://api.openai.com/v1" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "hosted-key" }) } };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("auth failure", { provider: "auto", extensionContext: ctx });
			console.log(JSON.stringify({ ok: true, calls }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error), calls }));
		}
	`, {
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tavily-must-not-run",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /openai search failed \(auth\)/i);
	assert.deepEqual(output.calls, ["https://api.openai.com/v1/responses"]);
});

test("a Hosted response without web_search_call is invalid and can fall back", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["openai", "tavily"], useCurrentModel: true, fallbackOn: ["invalid-response"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.openai.com/v1/responses") return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "hallucinated answer" }] }] }), { status: 200 });
			if (target === "https://api.tavily.com/search") return new Response(JSON.stringify({ answer: "Validated fallback", results: [] }), { status: 200 });
			throw new Error("Unexpected fetch: " + target);
		};
		const ctx = { model: { provider: "openai", api: "openai-responses", id: "gpt-5.6", baseUrl: "https://api.openai.com/v1" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "hosted-key" }) } };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("missing search call", { provider: "auto", extensionContext: ctx });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, calls }));
	`, {
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "tavily",
		answer: "Validated fallback",
		calls: ["https://api.openai.com/v1/responses", "https://api.tavily.com/search"],
	});
});

test("useCurrentModel is strictly validated", async () => {
	const home = await createConfig({ searchRouting: { providers: ["openai", "tavily"], useCurrentModel: "yes", fallbackOn: ["network"] } });
	const child = runChild(`
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("invalid current model config", { provider: "auto" });
			console.log(JSON.stringify({ ok: true }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error) }));
		}
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /searchRouting\.useCurrentModel .*boolean/);
});

test("Curator auto default follows the same current-model Hosted Search eligibility", async () => {
	const home = await createConfig({
		searchRouting: { providers: ["openai", "tavily"], useCurrentModel: true, fallbackOn: ["unsupported", "network"] },
	});
	const child = runChild(`
		const { resolveCuratorDefaultProvider } = await import(${JSON.stringify(indexModuleUrl)});
		const available = {
			all: true, openai: true, brave: false, parallel: false, "parallel-mcp": false, tinyfish: false,
			search1api: false, searchinfinity: false, querit: false, tavily: true, firecrawl: false,
			jina: false, serpdive: false, searxng: false, duckduckgo: false, perplexity: false,
			exa: false, gemini: false, kagi: false, bocha: false, ollama: false, anysearch: false,
			xai: false, brightdata: false, serpbase: false, serper: false, valyu: false,
		};
		const official = { model: { provider: "openai", api: "openai-responses", id: "gpt-5.6", baseUrl: "https://api.openai.com/v1" } };
		const proxy = { model: { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://ai.feei.cn/v1" } };
		console.log(JSON.stringify({ official: resolveCuratorDefaultProvider("auto", available, official), proxy: resolveCuratorDefaultProvider("auto", available, proxy) }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { official: "openai", proxy: "tavily" });
});
