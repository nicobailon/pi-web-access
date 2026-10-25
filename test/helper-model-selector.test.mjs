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

const { default: initializeExtension } = await import("../index.ts");
const { parseHelperModelSelector } = await import("../summary-model-scope.ts");
const { generateSummaryDraft } = await import("../summary-review.ts");

after(async () => {
	globalThis.fetch = originalFetch;
	process.env = previousEnv;
	await rm(root, { recursive: true, force: true });
});

const local = { provider: "strata", id: "strata", api: "fixture-api", reasoning: true, contextWindow: 32000, input: ["text"] };
const haiku = { provider: "anthropic", id: "claude-haiku-4-5", api: "fixture-api", reasoning: true, contextWindow: 32000, input: ["text"] };
const results = [{ query: "q", answer: "A.", results: [{ title: "S", url: "https://example.com" }], error: null, provider: "test" }];

function registry(models, calls) {
	return {
		find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
		getAvailable: () => models,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
		complete: async (model, _request, options) => {
			calls.push({ model: `${model.provider}/${model.id}`, reasoning: options.reasoning });
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

async function autoSummary(summaryModel) {
	await writeFile(configPath, JSON.stringify({ workflow: "none", ...(summaryModel === undefined ? {} : { summaryModel }) }));
	const tools = [];
	initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
	globalThis.fetch = async () => Response.json({ web: { results: [{ title: "Source", url: "http://93.184.216.34/", description: "snippet" }] } });
	const calls = [];
	const ctx = { model: local, scopedModels: [], modelRegistry: registry([haiku, local], calls) };
	const search = tools.find(tool => tool.name === "web_search");
	await search.execute("s", { query: "q", provider: "brave", workflow: "auto-summary" }, undefined, undefined, ctx);
	return calls;
}

test("auto-summary uses the session model for summaryModel current and keeps the default chain when unset", async () => {
	assert.deepEqual(await autoSummary("current:low"), [{ model: "strata/strata", reasoning: "low" }]);
	assert.deepEqual(await autoSummary(undefined), [{ model: "anthropic/claude-haiku-4-5", reasoning: undefined }]);
});

test("malformed summaryModel fails auto-summary with the config path", async () => {
	for (const value of ["nope", 42, ""]) {
		await assert.rejects(autoSummary(value), error => error.message.includes(`summaryModel in ${configPath} must be "current", "current:<level>", or "provider/model-id[:<level>]"`));
	}
});
