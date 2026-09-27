import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../openai-search.ts", import.meta.url).href;

const openCodeGoModels = [
	{ provider: "opencode-go", id: "deepseek-v4-pro", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1" },
	{ provider: "opencode-go", id: "gpt-5.6-luna", api: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" },
	{ provider: "opencode-go", id: "gpt-6-luna", api: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" },
	{ provider: "opencode-go", id: "gpt-oss-120b", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1" },
	{ provider: "opencode-go", id: "gpt-realtime-2.1", api: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" },
	{ provider: "opencode-go", id: "space-bunny-free", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1" },
];

async function runSearch(t, { config, models, sessionId = "session-1", resolvedBaseUrl, resolvedHeaders = { "x-existing": "kept" }, withContext = true, redirectUrl, redirectStatus = 307 }) {
	const dir = await mkdtemp(join(tmpdir(), "pi-openai-opencode-headers-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "web-search.json"), JSON.stringify(config));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "" },
		input: `
			const requests = [];
			const redirectUrl = ${JSON.stringify(redirectUrl ?? null)};
			globalThis.fetch = async (url, init) => {
				requests.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body ? JSON.parse(init.body) : undefined });
				if (redirectUrl && requests.length === 1) return new Response(null, { status: ${redirectStatus}, headers: { location: redirectUrl } });
				return Response.json({ output: [
					{ type: "web_search_call" },
					{ type: "message", content: [{ type: "output_text", text: "Search answer" }] },
				] });
			};
			const models = ${JSON.stringify(models)};
			const sessionId = ${JSON.stringify(sessionId ?? null)};
			const ctx = {
				modelRegistry: {
					getAll: () => models,
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: ${JSON.stringify(resolvedHeaders)}, ...(${JSON.stringify(resolvedBaseUrl)} ? { baseUrl: ${JSON.stringify(resolvedBaseUrl)} } : {}) }),
				},
				sessionManager: { getSessionId: () => sessionId ?? undefined },
			};
			const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
			let result, error;
			try {
				result = await searchWithOpenAI("test query", { numResults: 1 }, ${withContext ? "ctx" : "undefined"});
			} catch (err) { error = err.message; }
			console.log(JSON.stringify({ requests, result, error }));
		`,
	});
	assert.equal(child.status, 0, child.stderr || String(child.error));
	return JSON.parse(child.stdout.trim());
}

const openCodeGoConfig = {
	openaiSearchProviders: ["opencode-go"],
	openaiUseProviderBaseUrl: true,
	openaiSearchModel: "gpt-6-luna",
};

const openCodeUrl = "https://opencode.ai/zen/v1/responses";
const openaiModel = { provider: "openai", id: "gpt-5.6-terra", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
const { openaiSearchModel: _unused, ...autoModelConfig } = openCodeGoConfig;

test("OpenAI search through opencode-go keeps provider headers and picks the newest versioned GPT model", async (t) => {
	const out = await runSearch(t, { config: autoModelConfig, models: openCodeGoModels });
	assert.equal(out.result.answer, "Search answer");
	const [request] = out.requests;
	assert.equal(request.url, "https://opencode.ai/zen/go/v1/responses");
	assert.equal(request.body.model, "gpt-6-luna");
	assert.equal(request.headers["x-existing"], "kept");
	assert.equal(request.headers["x-opencode-session"], "session-1");
	assert.equal(request.headers["x-opencode-client"], "pi");
});

for (const [name, options, url] of [
	["an explicit OpenCode URL with OpenCode credentials", { config: { openaiSearchProviders: ["opencode-go"], openaiResponsesUrl: openCodeUrl, openaiSearchModel: "gpt-6-luna" }, models: openCodeGoModels }, openCodeUrl],
	["an explicit OpenCode URL with standalone credentials", { config: { openaiApiKey: "standalone-key", openaiResponsesUrl: openCodeUrl }, models: [] }, openCodeUrl],
	["an explicit OpenCode URL with a non-OpenCode Pi model", { config: { openaiSearchProviders: ["openai"], openaiResponsesUrl: openCodeUrl }, models: [openaiModel] }, openCodeUrl],
]) {
	test(`OpenAI search sends OpenCode attribution to ${name}`, async (t) => {
		const out = await runSearch(t, options);
		assert.equal(out.error, undefined);
		assert.equal(out.requests[0].url, url);
		assert.equal(out.requests[0].headers["x-opencode-session"], "session-1");
		assert.equal(out.requests[0].headers["x-opencode-client"], "pi");
	});
}

for (const [name, options, url] of [
	["without a session id", { config: openCodeGoConfig, models: openCodeGoModels, sessionId: null }, "https://opencode.ai/zen/go/v1/responses"],
	["without an extension context", { config: { openaiApiKey: "standalone-key", openaiResponsesUrl: openCodeUrl }, models: [], withContext: false }, openCodeUrl],
	["when resolved auth overrides the provider base URL", { config: openCodeGoConfig, models: openCodeGoModels, resolvedBaseUrl: "https://resolved-gateway.example/v1" }, "https://resolved-gateway.example/v1/responses"],
	["to another explicit gateway, even when the registry supplies OpenCode headers", {
		config: { openaiSearchProviders: ["opencode-go"], openaiResponsesUrl: "https://other-gateway.example/v1/responses", openaiSearchModel: "gpt-6-luna" },
		models: openCodeGoModels,
		resolvedHeaders: { "X-OpenCode-Session": "registry-session", "x-opencode-client": "registry-client" },
	}, "https://other-gateway.example/v1/responses"],
	["after Codex credentials switch to the ChatGPT endpoint", {
		config: { openaiSearchProviders: ["openai-codex"], openaiResponsesUrl: openCodeUrl },
		models: [{ provider: "openai-codex", id: "gpt-5.6-terra", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }],
	}, "https://chatgpt.com/backend-api/codex/responses"],
	["through official providers", { config: {}, models: [openaiModel] }, "https://api.openai.com/v1/responses"],
]) {
	test(`OpenAI search omits OpenCode attribution ${name}`, async (t) => {
		const out = await runSearch(t, options);
		assert.equal(out.error, undefined);
		assert.equal(out.requests[0].url, url);
		assert.equal(out.requests[0].headers["x-opencode-session"], undefined);
		assert.equal(out.requests[0].headers["x-opencode-client"], undefined);
	});
}

test("OpenAI search strips attribution and provider auth across a cross-origin redirect", async (t) => {
	const out = await runSearch(t, {
		config: { openaiSearchProviders: ["opencode-go"], openaiResponsesUrl: openCodeUrl },
		models: openCodeGoModels,
		resolvedHeaders: { "x-provider-secret": "registry-secret" },
		redirectUrl: "https://redirect-target.example/v1/responses",
		redirectStatus: 302,
	});
	assert.equal(out.result.answer, "Search answer");
	assert.equal(out.requests[0].headers["x-provider-secret"], "registry-secret");
	assert.equal(out.requests[0].headers["x-opencode-session"], "session-1");
	const redirected = out.requests[1];
	assert.equal(redirected.url, "https://redirect-target.example/v1/responses");
	for (const header of ["authorization", "x-opencode-session", "x-opencode-client", "x-provider-secret"]) {
		assert.equal(redirected.headers[header], undefined, header);
	}
});

test("OpenAI search rejects an insecure explicit OpenCode URL before sending a request", async (t) => {
	const out = await runSearch(t, { config: { openaiApiKey: "standalone-key", openaiResponsesUrl: "http://opencode.ai/zen/v1/responses" }, models: [] });
	assert.match(out.error, /must use HTTPS for opencode\.ai/u);
	assert.equal(out.requests.length, 0);
});
