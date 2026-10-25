import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const previousEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "pi-helper-model-selector-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_WEB_ACCESS_CACHE_ROOT = root;
process.env.BRAVE_API_KEY = "fixture-key";
delete process.env.BRAVE_BASE_URL;
const configPath = join(root, "web-search.json");
const contractError = key => `${key} in ${configPath} must be "current", "current:<level>", or "provider/model-id[:<level>]"`;

const { default: initializeExtension } = await import("../index.ts");
const { resolveHelperModelSelector } = await import("../summary-model-scope.ts");
const { generateSummaryDraft } = await import("../summary-review.ts");
const { rewriteSearchQuery } = await import("../query-rewrite.ts");

after(async () => {
	globalThis.fetch = originalFetch;
	process.env = previousEnv;
	await rm(root, { recursive: true, force: true });
});

const local = { provider: "strata", id: "strata", api: "fixture-api", reasoning: true, contextWindow: 32000, input: ["text"] };
const haiku = { provider: "anthropic", id: "claude-haiku-4-5", api: "fixture-api", reasoning: true, contextWindow: 32000, input: ["text"] };
const results = [{ query: "q", answer: "A.", results: [{ title: "S", url: "https://example.com" }], error: null, provider: "test" }];

function registry(models, calls, failing) {
	return {
		find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
		getAvailable: () => models,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
		complete: async (model, _request, options) => {
			calls.push({ model: `${model.provider}/${model.id}`, reasoning: options.reasoning });
			if (model === failing) throw new Error("local server down");
			return { stopReason: "stop", content: [{ type: "text", text: "SUMMARY" }] };
		},
	};
}

test("helper model selectors accept current, thinking suffixes, and provider/model-id", () => {
	assert.deepEqual(resolveHelperModelSelector(" current:low ", "summary model", local), { provider: "strata", id: "strata", thinkingLevel: "low" });
	assert.equal(resolveHelperModelSelector("current", "summary model"), undefined);
	assert.deepEqual(resolveHelperModelSelector("openrouter/x/y:free", "summary model"), { provider: "openrouter", id: "x/y:free", thinkingLevel: undefined });
	for (const value of ["foo", "/x", "x/", "current:bogus", ""]) {
		assert.throws(() => resolveHelperModelSelector(value, "summary model"), /^Error: Invalid summary model: .*Use provider\/model-id or current\.$/);
	}
});

test("summary drafts try only the given model unless preferredFallback is on", async () => {
	const draft = async (override, { scopedModels = [], failing, options } = {}) => {
		const calls = [];
		const ctx = { model: local, modelRegistry: registry([haiku, local], calls, failing), scopedModels };
		const { meta } = await generateSummaryDraft(results, ctx, undefined, override, undefined, undefined, 1000, undefined, options);
		return { calls, reason: meta.fallbackReason };
	};
	const strict = { preferredFallback: false };
	assert.deepEqual(await draft("strata/strata", { failing: local, options: strict }), { calls: [{ model: "strata/strata", reasoning: undefined }], reason: "summary-model-unavailable: local server down" });
	assert.deepEqual(await draft("current", { scopedModels: [{ model: haiku }], options: strict }), { calls: [], reason: "summary-model-unavailable: Summary model is not enabled: strata/strata" });
	assert.deepEqual(await draft("ollama/missing"), { calls: [{ model: "anthropic/claude-haiku-4-5", reasoning: undefined }], reason: undefined });
});

async function searchTool(config) {
	await writeFile(configPath, JSON.stringify({ workflow: "none", ...config }));
	const tools = [];
	initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
	globalThis.fetch = async (url, init) => String(url).startsWith("https://api.search.brave.com/")
		? Response.json({ web: { results: [{ title: "Source", url: "http://93.184.216.34/", description: "snippet" }] } })
		: originalFetch(url, init);
	return tools.find(tool => tool.name === "web_search");
}

async function autoSummary(summaryModel) {
	const search = await searchTool(summaryModel === undefined ? {} : { summaryModel });
	const calls = [];
	const ctx = { model: local, scopedModels: [], modelRegistry: registry([haiku, local], calls) };
	const result = await search.execute("s", { query: "q", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
	return { calls, fallbackReason: result.details.summary.fallbackReason };
}

test("auto-summary follows summaryModel without falling back, and keeps the default chain when unset", async () => {
	assert.deepEqual(await autoSummary("current:low"), { calls: [{ model: "strata/strata", reasoning: "low" }], fallbackReason: undefined });
	assert.deepEqual(await autoSummary("ollama/missing"), { calls: [], fallbackReason: "summary-model-unavailable: Summary model not found: ollama/missing" });
	assert.deepEqual(await autoSummary(undefined), { calls: [{ model: "anthropic/claude-haiku-4-5", reasoning: undefined }], fallbackReason: undefined });
});

test("malformed summaryModel fails auto-summary with the config path", async () => {
	for (const value of ["nope", 42, ""]) {
		await assert.rejects(autoSummary(value), error => error.message.includes(contractError("summaryModel")));
	}
});

test("queryRewriteModel selects the only model used for query rewrite", async () => {
	const flash = { ...haiku, provider: "google", id: "gemini-3.6-flash" };
	const rewrite = async (selector, model = local) => {
		const calls = [];
		const ctx = { model, modelRegistry: registry([haiku, flash, local], calls), scopedModels: [] };
		const outcome = await rewriteSearchQuery("q", ctx, new AbortController().signal, selector).catch(error => error.message);
		return { outcome, calls };
	};
	assert.deepEqual(await rewrite("current:low"), { outcome: "SUMMARY", calls: [{ model: "strata/strata", reasoning: "low" }] });
	assert.deepEqual(await rewrite("google/gemini-3.6-flash"), { outcome: "SUMMARY", calls: [{ model: "google/gemini-3.6-flash", reasoning: undefined }] });
	assert.deepEqual(await rewrite("ollama/missing"), { outcome: "Query rewrite model not found: ollama/missing", calls: [] });
	assert.deepEqual(await rewrite("current", null), { outcome: "Query rewrite model not found: current (no active Pi session model)", calls: [] });
	assert.deepEqual(await rewrite(undefined), { outcome: "SUMMARY", calls: [{ model: "anthropic/claude-haiku-4-5", reasoning: undefined }] });
});

async function curator(config, model) {
	const search = await searchTool({ autoOpenBrowser: false, curatorTimeoutSeconds: 5, ...config });
	const calls = [];
	const ctx = { model, scopedModels: [], modelRegistry: registry([haiku, local], calls), cwd: "", isProjectTrusted: () => true, ui: { notify() {} } };
	const controller = new AbortController();
	let revealUrl;
	const urlReady = new Promise(resolve => { revealUrl = resolve; });
	const execution = search.execute("c", { query: "q", provider: "brave", workflow: "summary-review" }, controller.signal, update => {
		if (update.details?.curatorUrl) revealUrl(new URL(update.details.curatorUrl));
	}, ctx);
	const url = await urlReady;
	const token = url.searchParams.get("session");
	const stateUrl = new URL(`/state?session=${token}`, url.origin);
	while (!(await (await originalFetch(stateUrl)).json()).done) await new Promise(resolve => setTimeout(resolve, 10));
	const post = async (path, body) => (await originalFetch(new URL(path, url.origin), {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }),
	})).json();
	return { calls, html: await (await originalFetch(url)).text(), post, close: async () => { controller.abort(); await execution; } };
}

test("curator rewrite and Auto summary use only the configured helper models", async () => {
	const session = await curator({ summaryModel: "ollama/missing", queryRewriteModel: "current" }, local);
	try {
		assert.match(session.html, /"defaultSummaryModel":"ollama\/missing"/);
		assert.equal((await session.post("/rewrite", { query: "q" })).query, "SUMMARY");
		assert.deepEqual(session.calls, [{ model: "strata/strata", reasoning: undefined }]);
		const summary = await session.post("/summarize", { selected: [0] });
		assert.equal(summary.meta.fallbackReason, "summary-model-unavailable: Summary model not found: ollama/missing");
		assert.equal(session.calls.length, 1);
		await writeFile(configPath, JSON.stringify({ queryRewriteModel: 42 }));
		assert.equal((await session.post("/rewrite", { query: "q" })).error, contractError("queryRewriteModel"));
	} finally {
		await session.close();
	}
});

test("curator lists no models for summaryModel current without a session model", async () => {
	const session = await curator({ summaryModel: "current" }, undefined);
	try {
		assert.match(session.html, /"summaryModels":\[\]/);
		const summary = await session.post("/summarize", { selected: [0] });
		assert.equal(summary.meta.fallbackReason, "summary-model-unavailable: Summary model not found: current (no active Pi session model)");
		assert.deepEqual(session.calls, []);
	} finally {
		await session.close();
	}
});
