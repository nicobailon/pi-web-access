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

async function runSearch(t, { config, models, sessionId }) {
	const dir = await mkdtemp(join(tmpdir(), "pi-openai-opencode-headers-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "web-search.json"), JSON.stringify(config));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "" },
		input: `
			const requests = [];
			globalThis.fetch = async (url, init) => {
				requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
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
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-existing": "kept" } }),
				},
				sessionManager: { getSessionId: () => sessionId ?? undefined },
			};
			const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
			let result, error;
			try {
				result = await searchWithOpenAI("test query", { numResults: 1 }, ctx);
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

test("OpenAI search through opencode-go sends OpenCode session attribution", async (t) => {
	const out = await runSearch(t, { config: openCodeGoConfig, models: openCodeGoModels, sessionId: "search-session-1" });

	assert.equal(out.error, undefined);
	assert.equal(out.result.answer, "Search answer");
	assert.equal(out.requests.length, 1);
	const [request] = out.requests;
	assert.equal(request.url, "https://opencode.ai/zen/go/v1/responses");
	assert.equal(request.body.model, "gpt-6-luna");
	assert.equal(request.headers["x-opencode-session"], "search-session-1");
	assert.equal(request.headers["x-opencode-client"], "pi");
	assert.equal(request.headers["x-existing"], "kept");
});

test("OpenAI search through opencode-go omits attribution without a session id", async (t) => {
	const out = await runSearch(t, { config: openCodeGoConfig, models: openCodeGoModels });

	assert.equal(out.error, undefined);
	const [request] = out.requests;
	assert.equal(request.headers["x-opencode-session"], undefined);
	assert.equal(request.headers["x-opencode-client"], undefined);
	assert.equal(request.headers["x-existing"], "kept");
});

test("OpenAI search with OpenCode credentials does not send attribution to another explicit gateway", async (t) => {
	const out = await runSearch(t, {
		config: {
			openaiSearchProviders: ["opencode-go"],
			openaiResponsesUrl: "https://other-gateway.example/v1/responses",
			openaiSearchModel: "gpt-6-luna",
		},
		models: openCodeGoModels,
		sessionId: "search-session-4",
	});

	assert.equal(out.error, undefined);
	const [request] = out.requests;
	assert.equal(request.url, "https://other-gateway.example/v1/responses");
	assert.equal(request.headers["x-opencode-session"], undefined);
	assert.equal(request.headers["x-opencode-client"], undefined);
	assert.equal(request.headers["x-existing"], "kept");
});

test("OpenAI search with OpenCode credentials sends attribution to an explicit OpenCode URL", async (t) => {
	const out = await runSearch(t, {
		config: {
			openaiSearchProviders: ["opencode-go"],
			openaiResponsesUrl: "https://opencode.ai/zen/go/v1/responses",
			openaiSearchModel: "gpt-6-luna",
		},
		models: openCodeGoModels,
		sessionId: "search-session-5",
	});

	assert.equal(out.error, undefined);
	const [request] = out.requests;
	assert.equal(request.url, "https://opencode.ai/zen/go/v1/responses");
	assert.equal(request.headers["x-opencode-session"], "search-session-5");
	assert.equal(request.headers["x-opencode-client"], "pi");
});

test("OpenAI search through opencode-go picks the newest versioned GPT model without openaiSearchModel", async (t) => {
	const { openaiSearchModel: _unused, ...config } = openCodeGoConfig;
	const out = await runSearch(t, { config, models: openCodeGoModels, sessionId: "search-session-3" });

	assert.equal(out.error, undefined);
	const [request] = out.requests;
	assert.equal(request.url, "https://opencode.ai/zen/go/v1/responses");
	assert.equal(request.body.model, "gpt-6-luna");
	assert.equal(request.headers["x-opencode-session"], "search-session-3");
});

test("OpenAI search through official providers does not send OpenCode attribution", async (t) => {
	const out = await runSearch(t, {
		config: {},
		models: [{ provider: "openai", id: "gpt-5.6-terra", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
		sessionId: "search-session-2",
	});

	assert.equal(out.error, undefined);
	const [request] = out.requests;
	assert.equal(request.url, "https://api.openai.com/v1/responses");
	assert.equal(request.headers["x-opencode-session"], undefined);
	assert.equal(request.headers["x-opencode-client"], undefined);
	assert.equal(request.headers["x-existing"], "kept");
});
