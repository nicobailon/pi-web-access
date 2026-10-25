import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const CF_URL = "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clef";
const CF_TOKEN = "cf-secret-token-123";

// The config path is fixed per process, so each scenario runs source_check in its own child with its own config.
function runSourceCheck(config, judgeReply) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-access-claim-judge-"));
	writeFileSync(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: "", HOME: join(agentDir, "home"), USERPROFILE: join(agentDir, "home") };
	Object.assign(env, { BRAVE_API_KEY: "brave-key", CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_API_TOKEN: CF_TOKEN, TYPESAFE_API_KEY: "ts-secret-key", JUDGE_REPLY: JSON.stringify(judgeReply ?? null) });
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			const reply = JSON.parse(process.env.JUDGE_REPLY);
			const judgeRequests = [];
			globalThis.fetch = async (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.startsWith("https://api.search.brave.com/")) return Response.json({ web: { results: [
					{ title: "A", url: "https://docs.example.com/a", description: "Responses can be streamed with stream: true." },
					{ title: "B", url: "https://docs.example.com/b", description: "Pricing starts at five dollars." },
				] } });
				judgeRequests.push({ url, authorization: init.headers.Authorization, body: JSON.parse(init.body) });
				return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
			};
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			const result = await tools.find((tool) => tool.name === "source_check").execute("call", { claim: "The API supports streaming", provider: "brave" }, undefined, undefined, {});
			console.log(JSON.stringify({ text: result.content[0].text, claim: result.details.artifact.claims[0], errors: result.details.artifact.errors, judgeRequests }));
		`,
		encoding: "utf8",
		env,
	});
	return child.status === 0 ? { ...JSON.parse(child.stdout.trim().split("\n").at(-1)), child } : { child };
}

const answers = ([supported, contradicted, notAddressed], evidence) => ({
	verdict: { type: "choice", choice: "supported", probabilities: { supported, contradicted, not_addressed: notAddressed } },
	evidence: { type: "choice", choice: evidence },
});
const cloudflare = (verdict, evidence) => ({ body: { success: true, result: { model: "clef", answers: answers(verdict, evidence) } } });
const clef = { sourceCheck: { judgeModel: "clef" } };

test("a clef verdict above its threshold reports supported with the cited passage and sends the measured questions", () => {
	const run = runSourceCheck(clef, cloudflare([0.97, 0.01, 0.02], "p-1-0"));
	assert.equal(run.claim.status, "supported");
	assert.deepEqual(run.claim.supporting_passages, ["p-1-0"]);
	assert.deepEqual(run.claim.contradicting_passages, []);
	assert.equal(run.claim.confidence, 0.97);
	assert.match(run.text, /\*\*Status:\*\* supported \(confidence 0\.97\)\n\*\*Rationale:\*\* Claim judge clef: supported 0\.97, contradicted 0\.01, not_addressed 0\.02; evidence p-1-0\.\n\*\*Supporting passages:\*\* p-1-0/);
	assert.equal(run.judgeRequests.length, 1);
	assert.equal(run.judgeRequests[0].url, CF_URL);
	assert.equal(run.judgeRequests[0].authorization, `Bearer ${CF_TOKEN}`);
	assert.deepEqual(run.judgeRequests[0].body, {
		model: "clef",
		state: { claim: "The API supports streaming", passages: [
			{ id: "p-1-0", text: "Responses can be streamed with stream: true." },
			{ id: "p-2-0", text: "Pricing starts at five dollars." },
		] },
		questions: {
			verdict: { type: "choice", instructions: "Judge only from the passages. supported: a passage clearly states the claim or something that directly implies it. contradicted: a passage clearly states the opposite or an incompatible fact. not_addressed: anything else, including passages on the topic that do not settle the claim, weaker or stronger statements, another product or version, and rumors.", criteria: { supported: null, contradicted: null, not_addressed: null } },
			evidence: { type: "choice", instructions: "Which passage id best justifies the verdict? Answer none if the verdict is not_addressed.", criteria: { "p-1-0": null, "p-2-0": null, none: null } },
		},
	});
});

test("a verdict below its threshold stays unclear without passage ids", () => {
	const run = runSourceCheck(clef, cloudflare([0.84, 0.06, 0.10], "p-1-0"));
	assert.equal(run.claim.status, "unclear");
	assert.deepEqual([run.claim.supporting_passages, run.claim.contradicting_passages], [[], []]);
	assert.equal(run.claim.confidence, 0.84);
	assert.match(run.claim.rationale, /^Claim judge clef: supported 0\.84, contradicted 0\.06, not_addressed 0\.10; evidence p-1-0\. No verdict reached its threshold/);
});

test("a confident verdict without a cited passage stays unclear", () => {
	const run = runSourceCheck(clef, cloudflare([0.97, 0.01, 0.02], "none"));
	assert.equal(run.claim.status, "unclear");
	assert.deepEqual(run.claim.supporting_passages, []);
	assert.match(run.claim.rationale, /^Claim judge clef: supported 0\.97, .*; evidence none\. No verdict reached its threshold/);
});

test("each model applies its own contradicted threshold", () => {
	const viaClef = runSourceCheck(clef, cloudflare([0.02, 0.88, 0.10], "p-1-0"));
	assert.equal(viaClef.claim.status, "contradicted");
	assert.deepEqual(viaClef.claim.contradicting_passages, ["p-1-0"]);
	const viaJev = runSourceCheck({ sourceCheck: { judgeModel: "jev-1.13.0" } }, { body: { model: "jev-1.13.0", answers: answers([0.02, 0.88, 0.10], "p-1-0") } });
	assert.equal(viaJev.judgeRequests[0].url, "https://api.typesafe.ai/v1/systemone");
	assert.equal(viaJev.judgeRequests[0].authorization, "Bearer ts-secret-key");
	assert.equal(viaJev.judgeRequests[0].body.model, "jev-1.13.0");
	assert.equal(viaJev.claim.status, "unclear");
});

test("a judge failure is unclear, recorded in the artifact errors, and never shows the credential", () => {
	const serverError = runSourceCheck(clef, { status: 500, body: `upstream rejected Bearer ${CF_TOKEN}` });
	assert.equal(serverError.claim.status, "unclear");
	assert.match(serverError.claim.rationale, /^Claim judge clef failed: Cloudflare Workers AI returned HTTP 500: upstream rejected Bearer \[redacted\]; review the passages\.$/);
	assert.equal(serverError.errors.at(-1).query, "claim judge");
	assert.ok(![serverError.text, JSON.stringify(serverError.claim), JSON.stringify(serverError.errors)].some((output) => output.includes(CF_TOKEN)));
	const badProbabilities = runSourceCheck(clef, cloudflare([0.9, 0.3, 0.1], "p-1-0"));
	assert.equal(badProbabilities.claim.status, "unclear");
	assert.match(badProbabilities.errors.at(-1).error, /verdict probabilities do not sum to 1/);
});

test("without sourceCheck config no judge is called", () => {
	const run = runSourceCheck({}, cloudflare([0.97, 0.01, 0.02], "p-1-0"));
	assert.equal(run.judgeRequests.length, 0);
	assert.equal(run.claim.status, "unclear");
	assert.equal(run.claim.confidence, 0.3);
});

test("an unknown judgeModel fails extension load naming the config path", () => {
	const { child } = runSourceCheck({ sourceCheck: { judgeModel: "clef-flash" } });
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /sourceCheck\.judgeModel in .*web-search\.json must be "clef" or "jev-1\.13\.0"/);
});
