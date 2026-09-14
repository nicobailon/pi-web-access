import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { generateSummaryDraft } from "../summary-review.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-summary-opencode-"));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({
	enabledModels: ["opencode-go/deepseek-v4-flash", "anthropic/claude-haiku-4-5", "test/summary-model"],
}));
process.env.PI_CODING_AGENT_DIR = agentDir;

after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

const results = [{
	query: "test query",
	answer: "A test answer.",
	results: [{ title: "Source", url: "https://example.test" }],
	error: null,
	provider: "test",
}];

function context(models, complete) {
	return {
		modelRegistry: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			getAvailable: () => models,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-existing": "kept" } }),
			...(complete ? { complete } : {}),
		},
		sessionManager: { getSessionId: () => "summary-session-385" },
		cwd: process.cwd(),
		isProjectTrusted: () => false,
	};
}

function openCodeModel() {
	return {
		provider: "opencode-go",
		id: "deepseek-v4-flash",
		api: "openai-completions",
		baseUrl: "https://opencode.ai/zen/go/v1",
	};
}

test("registry summary attributes the configured OpenCode candidate instead of falling through", async () => {
	const configured = openCodeModel();
	const fallback = { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" };
	const calls = [];
	const ctx = context([configured, fallback], async (model, _request, options) => {
		calls.push(model);
		if (model !== configured) throw new Error("configured candidate silently fell through");
		assert.equal(typeof options.transformHeaders, "function");
		const headers = await options.transformHeaders({ accept: "application/json" });
		assert.deepEqual(headers, {
			accept: "application/json",
			"x-opencode-session": "summary-session-385",
			"x-opencode-client": "pi",
		});
		return { stopReason: "stop", content: [{ type: "text", text: "OpenCode registry summary" }] };
	});

	const result = await generateSummaryDraft(results, ctx, undefined, "opencode-go/deepseek-v4-flash");

	assert.equal(result.summary, "OpenCode registry summary");
	assert.equal(result.meta.model, "opencode-go/deepseek-v4-flash");
	assert.equal(result.meta.fallbackUsed, false);
	assert.deepEqual(calls, [configured]);
});

test("direct summary completion merges OpenCode attribution with provider headers", async () => {
	const model = openCodeModel();
	let calls = 0;
	const result = await generateSummaryDraft(
		results,
		context([model]),
		undefined,
		"opencode-go/deepseek-v4-flash",
		undefined,
		(_model, _request, options) => {
			calls += 1;
			assert.deepEqual(options.headers, {
				"x-existing": "kept",
				"x-opencode-session": "summary-session-385",
				"x-opencode-client": "pi",
			});
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "OpenCode direct summary" }] });
		},
	);

	assert.equal(result.meta.model, "opencode-go/deepseek-v4-flash");
	assert.equal(calls, 1);
});

test("non-OpenCode registry summaries do not install a header transform", async () => {
	const model = { provider: "test", id: "summary-model", api: "custom" };
	const ctx = context([model], async (_model, _request, options) => {
		assert.equal(options.transformHeaders, undefined);
		return { stopReason: "stop", content: [{ type: "text", text: "Unchanged summary" }] };
	});

	const result = await generateSummaryDraft(results, ctx, undefined, "test/summary-model");
	assert.equal(result.meta.model, "test/summary-model");
});

test("non-OpenCode direct summaries preserve provider headers", async () => {
	const model = { provider: "test", id: "summary-model", api: "custom" };
	const providerHeaders = { "x-existing": "kept" };
	const ctx = context([model]);
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key", headers: providerHeaders });

	await generateSummaryDraft(results, ctx, undefined, "test/summary-model", undefined, (_model, _request, options) => {
		assert.equal(options.headers, providerHeaders);
		return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Unchanged direct summary" }] });
	});
});

test("thinking summary completion sends OpenCode attribution headers", () => {
	const summaryUrl = new URL("../summary-review.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		timeout: 10_000,
		input: `
			import assert from "node:assert/strict";
			import { mkdtemp, writeFile } from "node:fs/promises";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			import { register } from "node:module";

			const compatSource = \`
				export const complete = () => { throw new Error("complete must not be used for a thinking request"); };
				export const completeSimple = (...args) => globalThis.completeSimple(...args);
			\`;
			const aiSource = \`export const clampThinkingLevel = (_model, level) => level;\`;
			const loaderSource = \`
				export async function resolve(specifier, context, next) {
					if (specifier === "@earendil-works/pi-ai/compat") return { url: "data:text/javascript," + encodeURIComponent(\${JSON.stringify(compatSource)}), shortCircuit: true };
					if (specifier === "@earendil-works/pi-ai") return { url: "data:text/javascript," + encodeURIComponent(\${JSON.stringify(aiSource)}), shortCircuit: true };
					return next(specifier, context);
				}
			\`;
			register("data:text/javascript," + encodeURIComponent(loaderSource), import.meta.url);
			const agentDir = await mkdtemp(join(tmpdir(), "summary-thinking-opencode-"));
			await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["opencode-go/deepseek-v4-flash"] }));
			process.env.PI_CODING_AGENT_DIR = agentDir;
			let calls = 0;
			globalThis.completeSimple = (_model, _request, options) => {
				calls += 1;
				assert.deepEqual(options.headers, {
					"x-existing": "kept",
					"x-opencode-session": "thinking-session-385",
					"x-opencode-client": "pi",
				});
				return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Thinking summary" }] });
			};
			const model = { provider: "opencode-go", id: "deepseek-v4-flash", api: "openai-completions", reasoning: true };
			const { generateSummaryDraft } = await import(${JSON.stringify(summaryUrl)});
			const result = await generateSummaryDraft(${JSON.stringify(results)}, {
				modelRegistry: {
					find: () => model,
					getAvailable: () => [model],
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-existing": "kept" } }),
				},
				sessionManager: { getSessionId: () => "thinking-session-385" },
				cwd: agentDir,
				isProjectTrusted: () => false,
			}, undefined, "opencode-go/deepseek-v4-flash:high");
			assert.equal(result.summary, "Thinking summary");
			assert.equal(result.meta.model, "opencode-go/deepseek-v4-flash");
			assert.equal(calls, 1);
		`,
	});
	assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
});
