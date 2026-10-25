import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { default: initializeExtension, getQueryRewriteModel } = await import("../index.ts");
const { parseHelperModelSelector } = await import("../summary-model-scope.ts");
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
	assert.deepEqual(parseHelperModelSelector("current", "summary model"), { kind: "current", thinkingLevel: undefined });
	assert.deepEqual(parseHelperModelSelector(" current:low ", "summary model"), { kind: "current", thinkingLevel: "low" });
	assert.deepEqual(parseHelperModelSelector("a/b:high", "summary model"), { kind: "model", provider: "a", id: "b", thinkingLevel: "high" });
	assert.deepEqual(parseHelperModelSelector("openrouter/x/y:free", "summary model"), { kind: "model", provider: "openrouter", id: "x/y:free", thinkingLevel: undefined });
	for (const value of ["foo", "/x", "x/", "current:bogus"]) {
		assert.throws(() => parseHelperModelSelector(value, "summary model"), /^Error: Invalid summary model: .*Use provider\/model-id or current\.$/);
	}
});

test("summary model current resolves the session model and honors enabled models", async () => {
	const calls = [];
	const lowResult = await generateSummaryDraft(results, { model: local, modelRegistry: registry([haiku, local], calls), scopedModels: [] }, undefined, "current:low");
	assert.equal(lowResult.meta.model, "strata/strata");
	assert.deepEqual(calls, [{ model: "strata/strata", reasoning: "low" }]);

	calls.length = 0;
	const scopedResult = await generateSummaryDraft(results, { model: local, modelRegistry: registry([haiku, local], calls), scopedModels: [{ model: haiku }] }, undefined, "current");
	assert.equal(scopedResult.meta.model, "anthropic/claude-haiku-4-5");
	assert.deepEqual(calls, [{ model: "anthropic/claude-haiku-4-5", reasoning: undefined }]);
});

test("without preferredFallback only the configured summary model is tried", async () => {
	const draft = async (override, { scopedModels = [], failing, options } = {}) => {
		const calls = [];
		const ctx = { model: local, modelRegistry: registry([haiku, local], calls, failing), scopedModels };
		const { meta } = await generateSummaryDraft(results, ctx, undefined, override, undefined, undefined, 1000, undefined, options);
		return { calls: calls.map(call => call.model), reason: meta.fallbackReason };
	};
	const strict = { preferredFallback: false };
	assert.deepEqual(await draft("ollama/missing", { options: strict }), { calls: [], reason: "summary-model-unavailable: Summary model not found: ollama/missing" });
	assert.deepEqual(await draft("strata/strata", { failing: local, options: strict }), { calls: ["strata/strata"], reason: "summary-model-unavailable: local server down" });
	assert.deepEqual(await draft("current", { scopedModels: [{ model: haiku }], options: strict }), { calls: [], reason: "summary-model-unavailable: Summary model is not enabled: strata/strata" });
	assert.deepEqual(await draft("ollama/missing"), { calls: ["anthropic/claude-haiku-4-5"], reason: undefined });
});

async function autoSummary(summaryModel) {
	await writeFile(configPath, JSON.stringify({ workflow: "none", ...(summaryModel === undefined ? {} : { summaryModel }) }));
	const tools = [];
	initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
	globalThis.fetch = async () => Response.json({ web: { results: [{ title: "Source", url: "http://93.184.216.34/", description: "snippet" }] } });
	const calls = [];
	const ctx = { model: local, scopedModels: [], modelRegistry: registry([haiku, local], calls) };
	const search = tools.find(tool => tool.name === "web_search");
	const result = await search.execute("s", { query: "q", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
	return { calls, fallbackReason: result.details.summary.fallbackReason };
}

test("auto-summary uses the session model for summaryModel current and keeps the default chain when unset", async () => {
	assert.deepEqual((await autoSummary("current:low")).calls, [{ model: "strata/strata", reasoning: "low" }]);
	assert.deepEqual((await autoSummary(undefined)).calls, [{ model: "anthropic/claude-haiku-4-5", reasoning: undefined }]);
});

test("auto-summary with an unavailable summaryModel calls no other model", async () => {
	assert.deepEqual(await autoSummary("ollama/missing"), { calls: [], fallbackReason: "summary-model-unavailable: Summary model not found: ollama/missing" });
});

test("malformed summaryModel fails auto-summary with the config path", async () => {
	for (const value of ["nope", 42, ""]) {
		await assert.rejects(autoSummary(value), error => error.message.includes(`summaryModel in ${configPath} must be "current", "current:<level>", or "provider/model-id[:<level>]"`));
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
	assert.deepEqual(await rewrite("current"), { outcome: "SUMMARY", calls: [{ model: "strata/strata", reasoning: undefined }] });
	assert.deepEqual(await rewrite("current:low"), { outcome: "SUMMARY", calls: [{ model: "strata/strata", reasoning: "low" }] });
	assert.deepEqual(await rewrite("google/gemini-3.6-flash"), { outcome: "SUMMARY", calls: [{ model: "google/gemini-3.6-flash", reasoning: undefined }] });
	assert.deepEqual(await rewrite("ollama/missing"), { outcome: "Query rewrite model not found: ollama/missing", calls: [] });
	assert.deepEqual(await rewrite("current", null), { outcome: "Query rewrite model not found: current (no active Pi session model)", calls: [] });
	assert.deepEqual(await rewrite(undefined), { outcome: "SUMMARY", calls: [{ model: "anthropic/claude-haiku-4-5", reasoning: undefined }] });
});

test("queryRewriteModel config is read for each curator rewrite and validated", async () => {
	const read = async config => {
		await writeFile(configPath, JSON.stringify(config));
		try { return getQueryRewriteModel(); } catch (error) { return error.message; }
	};
	assert.equal(await read({}), undefined);
	assert.equal(await read({ queryRewriteModel: " current:low " }), "current:low");
	for (const value of ["nope", 42, ""]) {
		assert.equal(await read({ queryRewriteModel: value }), `queryRewriteModel in ${configPath} must be "current", "current:<level>", or "provider/model-id[:<level>]"`);
	}
	const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.equal(indexSrc.match(/rewriteSearchQuery\(query, (?:pc\.)?summaryContext, rewriteSignal, getQueryRewriteModel\(\)\)/g)?.length, 2);
});
