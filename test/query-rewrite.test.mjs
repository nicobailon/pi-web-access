import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-query-rewrite-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

const { rewriteSearchQuery } = await import("../query-rewrite.ts");

test("rewriteSearchQuery uses the registered provider runtime", async () => {
	const model = {
		api: "custom-rewrite-api",
		provider: "anthropic",
		id: "claude-haiku-4-5",
		input: ["text"],
	};
	let request;
	const signal = new AbortController().signal;
	const result = await rewriteSearchQuery(
		"http status codes",
		{
			modelRegistry: {
				find: () => model,
				getAvailable: () => [model],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
				complete: async (calledModel, context, options) => {
					request = { model: calledModel, context, options };
					return {
						stopReason: "stop",
						content: [{ type: "text", text: "HTTP status code semantics RFC 9110" }],
					};
				},
			},
			scopedModels: [],
		},
		signal,
	);

	assert.equal(result, "HTTP status code semantics RFC 9110");
	assert.equal(request.model, model);
	assert.equal(request.options.signal, signal);
	assert.match(request.context.messages[0].content[0].text, /Query: http status codes/);
});

test("rewriteSearchQuery skips models outside the host's resolved scope", async () => {
	const haiku = { api: "custom-rewrite-api", provider: "anthropic", id: "claude-haiku-4-5", input: ["text"] };
	const flash = { api: "custom-rewrite-api", provider: "google", id: "gemini-3.6-flash", input: ["text"] };
	const used = [];
	const result = await rewriteSearchQuery(
		"http status codes",
		{
			modelRegistry: {
				find: (provider, id) => [haiku, flash].find(model => model.provider === provider && model.id === id),
				getAvailable: () => [haiku, flash],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
				complete: async (calledModel) => {
					used.push(`${calledModel.provider}/${calledModel.id}`);
					return { stopReason: "stop", content: [{ type: "text", text: "rewritten" }] };
				},
			},
			scopedModels: [{ model: flash }],
		},
		new AbortController().signal,
	);

	assert.equal(result, "rewritten");
	assert.deepEqual(used, ["google/gemini-3.6-flash"]);
});
