import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-virtual-model-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

const { answerFromPage } = await import("../page-query.ts");
const { generateSummaryDraft } = await import("../summary-review.ts");

// Pi's real runtime, with a virtual model that routes to a faux physical model.
const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ provider: "faux", models: [{ id: "physical" }] });
runtime.registerProvider("faux", {
	baseUrl: "http://faux.invalid",
	apiKey: "test-key",
	api: faux.api,
	streamSimple: faux.provider.streamSimple,
	models: [{ id: "physical", name: "Physical", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 4_000 }],
});
runtime.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route: () => ({ model: runtime.getModel("faux", "physical") }) });
const modelRegistry = new ModelRegistry(runtime);
const virtualModel = modelRegistry.find("router", "auto");
const routedModels = [];
let lastOptions;
const reply = (text) => (_context, options, _state, model) => {
	routedModels.push(`${model.provider}/${model.id}`);
	lastOptions = options;
	return fauxAssistantMessage(text);
};

test("answer mode routes the current virtual model to its physical model", async () => {
	faux.setResponses([reply("The value is 42.")]);
	const result = await answerFromPage(
		{ question: "What is the value?", pageText: "The value is 42.", sourceUrl: "https://example.com" },
		{ model: virtualModel, modelRegistry, scopedModels: [] },
	);
	assert.match(result.text, /^The value is 42\./);
	assert.equal(routedModels.at(-1), "faux/physical");
	assert.equal(lastOptions.cacheRetention, "none");
	assert.equal(lastOptions.maxTokens, 2_000);
});

test("search summaries route a virtual summaryModel instead of falling back", async () => {
	faux.setResponses([reply("Routed summary.")]);
	const result = await generateSummaryDraft(
		[{ query: "q", answer: "Answer.", results: [{ title: "Source", url: "https://example.test" }], error: null, provider: "p" }],
		{ modelRegistry, scopedModels: [] },
		undefined,
		"router/auto",
	);
	assert.equal(result.meta.fallbackUsed, false, result.meta.fallbackReason);
	assert.equal(result.summary, "Routed summary.");
	assert.equal(routedModels.at(-1), "faux/physical");
});
