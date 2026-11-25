import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const searchUrl = new URL("../gemini-search.ts", import.meta.url).href;
const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const ON = { PI_WEB_ACCESS_RETRIEVAL_ONLY: "1" };
const POLICY = /retrieval-only policy \(PI_WEB_ACCESS_RETRIEVAL_ONLY=1\)/;

// Records every request; model hosts answer so a leak shows up as a result, not just an error.
const recordFetch = `
const requests = [];
globalThis.fetch = async (input, init) => {
	const url = String(input instanceof Request ? input.url : input);
	requests.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
	if (url === "https://api.openai.com/v1/responses") {
		return Response.json({ output: [{ type: "web_search_call", action: { sources: [] } }, { type: "message", content: [{ type: "output_text", text: "openai answer" }] }] });
	}
	if (url.startsWith("https://mcp.exa.ai/mcp")) {
		const event = { result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://exa.example/r\\nText: exa answer" }] } };
		return new Response("data: " + JSON.stringify(event) + "\\n\\n", { headers: { "content-type": "text/event-stream" } });
	}
	if (url === "https://api.tavily.com/search") return Response.json({ answer: "tavily answer", results: [{ title: "T", url: "https://t.example", content: "c" }] });
	throw new Error("Unexpected fetch " + url);
};
`;

function child(config, script, env = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-retrieval-only-"));
	if (config !== undefined) writeFileSync(join(home, "web-search.json"), JSON.stringify(config) + "\n");
	const result = spawnSync(process.execPath, ["--input-type=module"], {
		input: `${recordFetch}\n${script}`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home"), ...env },
	});
	return result;
}

function output(result) {
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

const attempt = `const attempt = async (work) => { try { return { ok: await work() }; } catch (err) { return { error: err.message }; } };`;

test("auto skips OpenAI for Exa only while the policy is on", () => {
	const script = `
		const token = "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } })).toString("base64url") + ".signature";
		const model = { provider: "openai", api: "openai-responses", id: "gpt-5.6-terra", baseUrl: "https://api.openai.com/v1" };
		const ctx = { model, modelRegistry: { getAll: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: {} }), isUsingOAuth: () => true } };
		const { search } = await import(${JSON.stringify(searchUrl)});
		const result = await search("q", { provider: "auto", extensionContext: ctx });
		console.log(JSON.stringify({ provider: result.provider, urls: requests.map(r => r.url) }));
	`;
	const off = output(child(undefined, script));
	assert.equal(off.provider, "openai");
	const on = output(child(undefined, script, ON));
	assert.equal(on.provider, "exa");
	assert.ok(on.urls.every(url => !url.includes("openai.com") && !url.includes("chatgpt.com")), on.urls.join(", "));
});

test("auto and all fail with the policy error when only model providers are usable", () => {
	const script = `
		${attempt}
		const { search } = await import(${JSON.stringify(searchUrl)});
		console.log(JSON.stringify({
			auto: await attempt(() => search("q", { provider: "auto" })),
			all: await attempt(() => search("q", { provider: "all" })),
			requests,
		}));
	`;
	const out = output(child({ webSearch: { allowedProviders: ["openai", "gemini", "brave"] } }, script, { ...ON, OPENAI_API_KEY: "sk-test", GEMINI_API_KEY: "g-test" }));
	assert.match(out.auto.error, new RegExp(POLICY.source + ".*skipped: openai, gemini\\."));
	assert.match(out.all.error, new RegExp(POLICY.source + ".*skipped: openai, gemini\\."));
	assert.deepEqual(out.requests, []);
	// Nothing was removed by the policy, so the usual setup guidance stays.
	const noModels = output(child({ webSearch: { allowedProviders: ["brave"] } }, script, ON));
	assert.match(noModels.auto.error, /^No search provider available\. Either:/);
	assert.doesNotMatch(noModels.all.error, /retrieval-only/);
});

test("explicit model providers and config that selects or only allows them are refused", () => {
	const explicit = output(child(undefined, `
		${attempt}
		const { search, validateSearchModelOverride } = await import(${JSON.stringify(searchUrl)});
		console.log(JSON.stringify({
			tabstack: await attempt(() => search("q", { provider: "tabstack" })),
			list: await attempt(() => search("q", { provider: ["brave", "openai", "gemini"] })),
			model: await attempt(async () => validateSearchModelOverride("xai", "grok-5")),
			requests,
		}));
	`, { ...ON, TABSTACK_API_KEY: "t", BRAVE_API_KEY: "b", XAI_API_KEY: "x" }));
	assert.match(explicit.tabstack.error, /Search provider "tabstack" is blocked by the retrieval-only policy/);
	assert.match(explicit.list.error, /^Search provider "openai" is blocked/);
	assert.match(explicit.model.error, /Search provider "xai" is blocked/);
	assert.deepEqual(explicit.requests, []);

	const searchFor = (config) => output(child(config, `
		${attempt}
		const { search } = await import(${JSON.stringify(searchUrl)});
		console.log(JSON.stringify(await attempt(() => search("q", { provider: "brave" }))));
	`, { ...ON, BRAVE_API_KEY: "b" }));
	assert.match(searchFor({ searchProvider: "openai" }).error, /Search provider "openai" set by searchProvider in .* is blocked/);
	assert.match(searchFor({ webSearch: { allowedProviders: ["openai", "xai"] } }).error, /No retrieval route is available .*: openai, xai\./);
});

test("the policy turns on from env or config, and config false cannot turn env off", () => {
	const blockedOpenAI = `
		${attempt}
		const { search } = await import(${JSON.stringify(searchUrl)});
		console.log(JSON.stringify(await attempt(() => search("q", { provider: "openai" }))));
	`;
	const fromConfig = output(child({ retrievalOnly: true }, blockedOpenAI, { OPENAI_API_KEY: "sk" })).error;
	assert.match(fromConfig, /retrieval-only policy \(retrievalOnly: true in .*web-search\.json\)/);
	const envOverConfig = output(child({ retrievalOnly: false }, blockedOpenAI, { ...ON, OPENAI_API_KEY: "sk" })).error;
	assert.match(envOverConfig, POLICY);

	const init = (config, env) => child(config, `
		const tools = [];
		(await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
		console.log(JSON.stringify({ model: "model" in tools.find(t => t.name === "web_search").parameters.properties }));
	`, env);
	assert.deepEqual(output(init(undefined, {})), { model: true });
	assert.deepEqual(output(init(undefined, ON)), { model: false });
	const badEnv = init(undefined, { PI_WEB_ACCESS_RETRIEVAL_ONLY: "2" });
	assert.notEqual(badEnv.status, 0);
	assert.match(badEnv.stderr, /PI_WEB_ACCESS_RETRIEVAL_ONLY must be 1, true, 0, or false/);
	const badConfig = init({ retrievalOnly: "yes" }, {});
	assert.notEqual(badConfig.status, 0);
	assert.match(badConfig.stderr, /retrievalOnly in .* must be a boolean/);
	const badMcpEnv = child(undefined, `(await import(${JSON.stringify(coreUrl)})).createStandaloneWebToolCore();`, { PI_WEB_ACCESS_RETRIEVAL_ONLY: "2" });
	assert.notEqual(badMcpEnv.status, 0);
	assert.match(badMcpEnv.stderr, /PI_WEB_ACCESS_RETRIEVAL_ONLY must be 1, true, 0, or false/);
});

test("over MCP a blocked provider reports the policy, not a missing key", () => {
	const out = output(child(undefined, `
		${attempt}
		const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreUrl)});
		const result = await attempt(() => createStandaloneWebToolCore().webSearch({ query: "q", provider: "openai" }));
		console.log(JSON.stringify({ ...result, requests }));
	`, ON));
	assert.match(out.error, POLICY);
	assert.deepEqual(out.requests, []);
});

test("Tavily is not asked for a model-written answer while the policy is on", () => {
	const script = `
		const { search } = await import(${JSON.stringify(searchUrl)});
		await search("q", { provider: "tavily" });
		console.log(JSON.stringify(JSON.parse(requests[0].body).include_answer));
	`;
	assert.equal(output(child(undefined, script, { TAVILY_API_KEY: "tvly" })), "basic");
	assert.equal(output(child(undefined, script, { ...ON, TAVILY_API_KEY: "tvly" })), false);
});

test("every built-in search, fetch and PDF provider is classified", async () => {
	const { RESOLVED_SEARCH_PROVIDERS } = await import(searchUrl);
	const { FETCH_PROVIDERS } = await import(new URL("../extract.ts", import.meta.url).href);
	const { PDF_PROVIDER_VALUES } = await import(new URL("../pdf-extract.ts", import.meta.url).href);
	const { SEARCH_PROVIDER_KINDS, FETCH_PROVIDER_KINDS, PDF_PROVIDER_KINDS } = await import(new URL("../retrieval-only.ts", import.meta.url).href);
	const kinds = ["model", "retrieval"];
	for (const provider of RESOLVED_SEARCH_PROVIDERS) assert.ok(kinds.includes(SEARCH_PROVIDER_KINDS[provider]), `search: ${provider}`);
	for (const provider of FETCH_PROVIDERS) assert.ok(kinds.includes(FETCH_PROVIDER_KINDS[provider]), `fetch: ${provider}`);
	for (const provider of [...PDF_PROVIDER_VALUES].filter(value => value !== "auto")) assert.ok(kinds.includes(PDF_PROVIDER_KINDS[provider]), `pdf: ${provider}`);
});
