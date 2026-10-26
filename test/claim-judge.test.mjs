import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The config path is fixed when the modules load, so point it at a temp dir first; each test rewrites the file.
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-access-claim-judge-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.BRAVE_API_KEY = "brave-key";
process.env.OLLAMA_API_KEY = "ollama-key";
const { default: initializeExtension } = await import("../index.ts");
const { judgeClaim } = await import("../claim-judge.ts");
const { createStandaloneWebToolCore } = await import("../web-tool-core.ts");

const CLEF = "cloudflare-workers-ai/@cf/cloudflare/clef";
const JEV_113 = "openrouter/typesafe/jev-1.13";

globalThis.fetch = async (input) => {
	const url = String(input instanceof Request ? input.url : input);
	// Ollama keeps an empty result title, unlike Brave, which replaces it with the URL.
	if (url === "https://ollama.com/api/web_search") return Response.json({ results: [{ title: "", url: "https://docs.example.com/untitled", content: "Responses can be streamed." }] });
	assert.match(url, /^https:\/\/api\.search\.brave\.com\//);
	return Response.json({ web: { results: [
		{ title: "A", url: "https://docs.example.com/a", description: "Responses can be streamed with stream: true." },
		{ title: "B", url: "https://docs.example.com/b", description: "Pricing starts at five dollars." },
	] } });
};

function withConfig(config) {
	writeFileSync(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
}

// A stand-in for Pi's ctx.modelRegistry that records every lookup and classify call. The question about the
// cited page's subject is answered with `otherSubject` (a probability, or a whole result object).
function fakeRegistry(result, model = { id: "classifier" }, otherSubject = 0.02) {
	const calls = { find: [], classify: [] };
	return {
		calls,
		findOfType(...args) { calls.find.push(args); return model; },
		async classify(found, context, options) {
			calls.classify.push({ found, context, options });
			if (!context.questions.other_subject) return result;
			return typeof otherSubject === "number" ? { stopReason: "stop", answers: { other_subject: { type: "bool", probability: otherSubject } } } : otherSubject;
		},
	};
}

const stop = ([supported, contradicted, notAddressed], evidence) => ({
	stopReason: "stop",
	answers: {
		verdict: { type: "choice", choice: "supported", probabilities: { supported, contradicted, not_addressed: notAddressed }, confidence: 0.9 },
		evidence: { type: "choice", choice: evidence, probabilities: {}, confidence: 0.9 },
	},
});

async function runSourceCheck(judgeModel, ctx, provider = "brave", params = {}) {
	withConfig(judgeModel ? { sourceCheck: { judgeModel } } : {});
	const tools = [];
	initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
	const result = await tools.find((tool) => tool.name === "source_check").execute("call", { claim: "The API supports streaming", provider, ...params }, undefined, undefined, ctx);
	return { result, claim: result.details.artifact.claims[0], errors: result.details.artifact.errors };
}

test("the judge looks up the reference in Pi's catalog and sends the measured state and questions", async () => {
	const registry = fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0"));
	const { result, claim } = await runSourceCheck(CLEF, { modelRegistry: registry });
	assert.deepEqual(registry.calls.find, [["classifier", "cloudflare-workers-ai", "@cf/cloudflare/clef"]]);
	assert.equal(registry.calls.classify[0].found.id, "classifier");
	assert.ok(registry.calls.classify[0].options.signal instanceof AbortSignal);
	assert.equal(JSON.stringify(registry.calls.classify[0].context), JSON.stringify({
		state: { claim: "The API supports streaming", passages: [
			{ id: "p-1-0", source: "A", text: "Responses can be streamed with stream: true." },
			{ id: "p-2-0", source: "B", text: "Pricing starts at five dollars." },
		] },
		questions: {
			verdict: { type: "choice", instructions: "Judge only from the passages. supported: a passage clearly states the claim or something that directly implies it. contradicted: a passage clearly states the opposite or an incompatible fact. not_addressed: anything else, including passages on the topic that do not settle the claim, weaker or stronger statements, another product or version, and rumors.", criteria: { supported: null, contradicted: null, not_addressed: null } },
			evidence: { type: "choice", instructions: "Which passage id best justifies the verdict? Answer none if the verdict is not_addressed.", criteria: { "p-1-0": null, "p-2-0": null, none: null } },
		},
	}));
	assert.deepEqual([claim.status, claim.supporting_passages, claim.confidence], ["supported", ["p-1-0"], 0.97]);
	assert.match(result.content[0].text, /\*\*Status:\*\* supported \(confidence 0\.97\)\n\*\*Rationale:\*\* Claim judge cloudflare-workers-ai\/@cf\/cloudflare\/clef: supported 0\.97, contradicted 0\.01, not_addressed 0\.02; evidence p-1-0; other subject 0\.02\.\n\*\*Supporting passages:\*\* p-1-0/);
});

test("a verdict whose cited page is about another product becomes unclear", async () => {
	const registry = fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0"), undefined, 0.29);
	const { claim } = await runSourceCheck(CLEF, { modelRegistry: registry });
	assert.equal(JSON.stringify(registry.calls.classify[1].context), JSON.stringify({
		state: { claim: "The API supports streaming", passage: { source: "A", text: "Responses can be streamed with stream: true." } },
		questions: { other_subject: { type: "bool", instructions: "The source is the title of the page the passage comes from. Does that title name a different product than the claim names, such as a sibling product of the same brand?", criteria: { true: null, false: null } } },
	}));
	assert.deepEqual([claim.status, claim.supporting_passages, claim.confidence], ["unclear", [], 0.97]);
	assert.equal(claim.rationale, `Claim judge ${CLEF}: supported 0.97, contradicted 0.01, not_addressed 0.02; evidence p-1-0; other subject 0.29. The cited page "A" looks like it is about a different product than the claim; review the passages. Only search snippets were checked; retry with fetchContent: true to include the pages.`);
	const below = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0"), undefined, 0.28) });
	assert.equal(below.claim.status, "supported");
	const jev = await runSourceCheck("typesafe/jev-latest", { modelRegistry: fakeRegistry(stop([0.02, 0.92, 0.06], "p-1-0"), undefined, 0.23) });
	assert.equal(jev.claim.status, "unclear");
});

test("the cited page's subject is asked about only after a verdict, and not for Jev 1.13", async () => {
	const noVerdict = fakeRegistry(stop([0.80, 0.05, 0.15], "p-1-0"));
	await runSourceCheck(CLEF, { modelRegistry: noVerdict });
	const jev113 = fakeRegistry(stop([0.02, 0.92, 0.06], "p-1-0"));
	const { claim } = await runSourceCheck(JEV_113, { modelRegistry: jev113 });
	assert.deepEqual([noVerdict.calls.classify.length, jev113.calls.classify.length, claim.status], [1, 1, "contradicted"]);
});

test("a failed or invalid answer about the cited page's subject is unclear, never a verdict", async () => {
	const failed = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0"), undefined, { stopReason: "error", errorMessage: "Cloudflare Workers AI returned 500", answers: {} }) });
	assert.deepEqual([failed.claim.status, failed.errors.at(-1).error], ["unclear", "Cloudflare Workers AI returned 500"]);
	const invalid = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0"), undefined, { stopReason: "stop", answers: { other_subject: { type: "bool" } } }) });
	assert.deepEqual([invalid.claim.status, invalid.errors.at(-1).error], ["unclear", "the response is invalid: the other-subject probability must be a number from 0 to 1"]);
});

test("each reference applies its own thresholds", async () => {
	const viaClef = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.02, 0.88, 0.10], "p-1-0")) });
	assert.deepEqual([viaClef.claim.status, viaClef.claim.contradicting_passages], ["contradicted", ["p-1-0"]]);
	const viaJev = await runSourceCheck(JEV_113, { modelRegistry: fakeRegistry(stop([0.02, 0.88, 0.10], "p-1-0")) });
	assert.equal(viaJev.claim.status, "unclear");
	assert.equal(viaJev.errors, undefined);
	assert.match(viaJev.claim.rationale, /^Claim judge openrouter\/typesafe\/jev-1\.13: supported 0\.02, contradicted 0\.88, not_addressed 0\.10; evidence p-1-0\. No verdict reached its threshold/);
	const jevLatest = await runSourceCheck("typesafe/jev-latest", { modelRegistry: fakeRegistry(stop([0.87, 0.03, 0.10], "p-1-0")) });
	assert.equal(jevLatest.claim.status, "unclear");
});

test("a confident verdict without a cited passage stays unclear", async () => {
	const { claim } = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.97, 0.01, 0.02], "none")) });
	assert.deepEqual([claim.status, claim.supporting_passages], ["unclear", []]);
	assert.match(claim.rationale, /; evidence none\. No verdict reached its threshold/);
});

test("an unclear verdict from snippets alone suggests fetching the pages", async () => {
	const hint = /Only search snippets were checked; retry with fetchContent: true to include the pages\.$/;
	const snippets = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.5, 0.1, 0.4], "p-1-0")) });
	assert.match(snippets.claim.rationale, hint);
	assert.match(snippets.result.content[0].text, /\*\*Rationale:\*\* .*retry with fetchContent: true/);
	const fetched = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.5, 0.1, 0.4], "p-1-0")) }, "brave", { fetchContent: true });
	assert.doesNotMatch(fetched.claim.rationale, hint);
	const supported = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0")) });
	assert.doesNotMatch(supported.claim.rationale, hint);
});

test("a classifier error is unclear, recorded in the artifact errors, and does not flag the call as failed", async () => {
	const { result, claim, errors } = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry({ stopReason: "error", errorMessage: "Cloudflare Workers AI returned 401", answers: {} }) });
	assert.equal(claim.status, "unclear");
	assert.equal(claim.rationale, `Claim judge ${CLEF} failed: Cloudflare Workers AI returned 401; review the passages.`);
	assert.deepEqual(errors, [{ query: "claim judge", error: "Cloudflare Workers AI returned 401" }]);
	assert.equal(result.isError, undefined);
});

test("an answer that does not check out is unclear with the reason", async () => {
	const { claim, errors } = await runSourceCheck(CLEF, { modelRegistry: fakeRegistry(stop([0.9, 0.3, 0.1], "p-1-0")) });
	assert.equal(claim.status, "unclear");
	assert.match(errors.at(-1).error, /verdict probabilities do not sum to 1/);
});

test("a reference missing from this Pi's catalog is unclear without a classify call", async () => {
	const registry = fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0"), null);
	const { claim } = await runSourceCheck(CLEF, { modelRegistry: registry });
	assert.equal(claim.rationale, `Claim judge ${CLEF} failed: ${CLEF} is not in this Pi's classifier catalog; review the passages.`);
	assert.equal(registry.calls.classify.length, 0);
});

test("without sourceCheck config no classifier is called", async () => {
	const registry = fakeRegistry(stop([0.97, 0.01, 0.02], "p-1-0"));
	const { claim } = await runSourceCheck(undefined, { modelRegistry: registry });
	assert.deepEqual([registry.calls.find.length, claim.status, claim.confidence], [0, "unclear", 0.3]);
});

test("without Pi's model registry, as over MCP, the judge does not run", async () => {
	withConfig({ sourceCheck: { judgeModel: CLEF } });
	const result = await createStandaloneWebToolCore().sourceCheck({ claim: "The API supports streaming", provider: "brave" });
	const { claims, errors } = result.details.artifact;
	assert.equal(claims[0].status, "unclear");
	assert.doesNotMatch(claims[0].rationale, /Claim judge/);
	assert.equal(errors, undefined);
});

test("at most 48 passages are sent and the rationale counts the rest", async () => {
	const passages = Array.from({ length: 60 }, (_, index) => ({ id: `p-${index + 1}-0`, source: "Docs", text: "short passage" }));
	const registry = fakeRegistry(stop([0.02, 0.02, 0.96], "none"));
	const { assessment } = await judgeClaim(CLEF, "claim", passages, registry);
	assert.equal(registry.calls.classify[0].context.state.passages.length, 48);
	assert.match(assessment.rationale, / 12 passages were left out to fit the request limit\.$/);
});

test("a source without a title is labeled with its URL", async () => {
	const registry = fakeRegistry(stop([0.02, 0.02, 0.96], "none"));
	await runSourceCheck(CLEF, { modelRegistry: registry }, "ollama");
	assert.equal(registry.calls.classify[0].context.state.passages[0].source, "https://docs.example.com/untitled");
});

test("page titles count toward the 24 KB request limit", async () => {
	const passages = Array.from({ length: 40 }, (_, index) => ({ id: `p-${index + 1}-0`, source: "T".repeat(800), text: "short passage" }));
	const registry = fakeRegistry(stop([0.02, 0.02, 0.96], "none"));
	const { assessment } = await judgeClaim(CLEF, "claim", passages, registry);
	const sent = registry.calls.classify[0].context.state.passages.length;
	assert.ok(sent < 40);
	assert.match(assessment.rationale, new RegExp(` ${40 - sent} passages were left out to fit the request limit\\.$`));
});

// A classify that, like Pi's, never rejects: it answers "aborted" once its signal aborts.
const pendingRegistry = () => ({
	findOfType: () => ({ id: "classifier" }),
	classify: (_model, _context, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "aborted", answers: {} }))),
});
const onePassage = [{ id: "p-1-0", source: "Docs", text: "short passage" }];

test("a classifier that takes longer than 10 s is reported as a timeout", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const judging = judgeClaim(CLEF, "claim", onePassage, pendingRegistry());
	t.mock.timers.tick(10_000);
	assert.equal((await judging).error, "timed out after 10 s");
});

test("a caller abort while the classifier runs is rethrown", async () => {
	const controller = new AbortController();
	const judging = judgeClaim(CLEF, "claim", onePassage, pendingRegistry(), controller.signal);
	controller.abort();
	await assert.rejects(judging, { name: "AbortError" });
});

test("a Pi without classifier support is unclear, not an exception", async () => {
	const { assessment } = await judgeClaim(CLEF, "claim", onePassage, { findOfType: () => ({ id: "classifier" }) });
	assert.equal(assessment.rationale, `Claim judge ${CLEF} failed: this Pi version cannot run classifier models; update Pi; review the passages.`);
});

test("an unknown judgeModel fails extension load naming the config path", () => {
	withConfig({ sourceCheck: { judgeModel: "clef" } });
	assert.throws(
		() => initializeExtension({ registerTool() {}, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} }),
		/sourceCheck\.judgeModel in .*web-search\.json must be one of "cloudflare-workers-ai\/@cf\/cloudflare\/clef", /,
	);
});
