import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { findModelWithProviderRouting, loadEnabledModelPatterns, modelMatchesEnabledPatterns } from "../summary-model-scope.ts";
import { generateSummaryDraft, SUMMARY_GENERATION_DEADLINE_MS } from "../summary-review.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const summarySrc = readFileSync(new URL("../summary-review.ts", import.meta.url), "utf8");
const queryRewriteSrc = readFileSync(new URL("../query-rewrite.ts", import.meta.url), "utf8");

function summaryContext() {
	const model = { provider: "anthropic", id: "claude-haiku-4-5" };
	return {
		modelRegistry: {
			find: () => model,
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		cwd: process.cwd(),
		isProjectTrusted: () => false,
	};
}

const summaryResults = [{
	query: "test query",
	answer: "A test answer.",
	results: [{ title: "Test source", url: "https://example.com" }],
	error: null,
	provider: "test",
}];

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-access-summary-deadline-"));
await writeFile(join(testAgentDir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5", "openrouter/nvidia/nemotron-3-super-120b-a12b:free"] }));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

test("never-settling summary completion returns a deterministic deadline fallback", async () => {
	let completionSignal;
	const neverSettles = new Promise(() => {});
	const startedAt = Date.now();
	const result = await generateSummaryDraft(
		summaryResults,
		summaryContext(),
		undefined,
		undefined,
		undefined,
		(_model, _request, options) => {
			completionSignal = options.signal;
			return neverSettles;
		},
		20,
	);

	assert.ok(Date.now() - startedAt < 500);
	assert.equal(result.meta.fallbackUsed, true);
	assert.equal(result.meta.fallbackReason, "summary-generation-timeout");
	assert.equal(result.meta.phase, "deterministic-fallback");
	assert.equal(completionSignal.aborted, true);
});

test("model resolution errors after the deadline return timeout fallback", async () => {
	const context = summaryContext();
	context.modelRegistry.getApiKeyAndHeaders = async () => {
		await new Promise(resolve => setTimeout(resolve, 30));
		throw new Error("late auth failure");
	};

	const result = await generateSummaryDraft(
		summaryResults,
		context,
		undefined,
		undefined,
		undefined,
		undefined,
		10,
	);

	assert.equal(result.meta.fallbackUsed, true);
	assert.equal(result.meta.fallbackReason, "summary-generation-timeout");
	assert.equal(result.meta.phase, "deterministic-fallback");
});

test("caller abort takes precedence over a pending summary completion", async () => {
	const controller = new AbortController();
	const neverSettles = new Promise(() => {});
	setTimeout(() => controller.abort(), 10);

	await assert.rejects(
		() => generateSummaryDraft(
			summaryResults,
			summaryContext(),
			controller.signal,
			undefined,
			undefined,
			() => neverSettles,
			1000,
		),
		/Aborted/,
	);
});

test("summary model scope matches nested provider model ids and thinking suffixes", () => {
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b:free" },
			["openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "anthropic/claude-sonnet-4" },
			["openrouter/*:low"],
		),
		true,
	);
	assert.equal(
		modelMatchesEnabledPatterns(
			{ provider: "openrouter", id: "ai21/jamba-large-1.7" },
			["openrouter/nvidia/*"],
		),
		false,
	);
});

test("summary generation resolves preferred models through routed providers", async () => {
	const routedModel = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	let completeCalled = false;
	const result = await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: () => undefined,
				getAvailable: () => [routedModel],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		},
		undefined,
		undefined,
		undefined,
		() => {
			completeCalled = true;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Routed summary" }] });
		},
		1000,
	);

	assert.equal(completeCalled, true);
	assert.equal(result.meta.fallbackUsed, false);
	assert.equal(result.meta.model, "openrouter/anthropic/claude-haiku-4-5");
});

test("summaryModel thinking suffix strips before lookup and reaches completion options", async () => {
	const model = { provider: "anthropic", id: "claude-haiku-4-5", reasoning: true };
	const lookups = [];
	let options;
	const result = await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: (provider, id) => {
					lookups.push({ provider, id });
					return model;
				},
				getAvailable: () => [],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		},
		undefined,
		"anthropic/claude-haiku-4-5:low",
		undefined,
		(_model, _request, requestOptions) => {
			options = requestOptions;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Low-thinking summary" }] });
		},
		1000,
	);

	assert.ok(lookups.some(lookup => lookup.provider === "anthropic" && lookup.id === "claude-haiku-4-5"));
	assert.equal(options.reasoning, "low");
	assert.equal(options.reasoningEffort, "low");
	assert.equal(result.meta.model, "anthropic/claude-haiku-4-5");
});

test("summaryModel keeps non-thinking colons in model ids", async () => {
	const model = { provider: "openrouter", id: "nvidia/nemotron-3-super-120b-a12b:free", reasoning: true };
	const lookups = [];
	let options;
	const result = await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: (provider, id) => {
					lookups.push({ provider, id });
					return model;
				},
				getAvailable: () => [],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		},
		undefined,
		"openrouter/nvidia/nemotron-3-super-120b-a12b:free",
		undefined,
		(_model, _request, requestOptions) => {
			options = requestOptions;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Free model summary" }] });
		},
		1000,
	);

	assert.ok(lookups.some(lookup => lookup.provider === "openrouter" && lookup.id === "nvidia/nemotron-3-super-120b-a12b:free"));
	assert.equal(options.reasoning, undefined);
	assert.equal(options.reasoningEffort, undefined);
	assert.equal(result.meta.model, "openrouter/nvidia/nemotron-3-super-120b-a12b:free");
});

test("summaryModel thinking suffix omits effort for non-reasoning models", async () => {
	const model = { provider: "anthropic", id: "claude-haiku-4-5", reasoning: false };
	let options;
	await generateSummaryDraft(
		summaryResults,
		{
			modelRegistry: {
				find: () => model,
				getAvailable: () => [model],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			},
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		},
		undefined,
		"anthropic/claude-haiku-4-5:low",
		undefined,
		(_model, _request, requestOptions) => {
			options = requestOptions;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "No-thinking summary" }] });
		},
		1000,
	);

	assert.equal(options.reasoning, "off");
	assert.equal(options.reasoningEffort, undefined);
});

test("preferred models resolve through routed providers", () => {
	const routedModel = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [routedModel],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		routedModel,
	);
});

test("model resolution preserves the direct registry fallback", () => {
	const configuredModel = { provider: "anthropic", id: "claude-haiku-4-5" };
	const registry = {
		find: () => configuredModel,
		getAvailable: () => [],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		configuredModel,
	);
});

test("routed model resolution follows available-model ordering", () => {
	const firstRoute = { provider: "openrouter", id: "anthropic/claude-haiku-4-5" };
	const secondRoute = { provider: "requesty", id: "anthropic/claude-haiku-4-5" };
	const registry = {
		find: () => undefined,
		getAvailable: () => [firstRoute, secondRoute],
	};

	assert.equal(
		findModelWithProviderRouting(registry, "anthropic", "claude-haiku-4-5"),
		firstRoute,
	);
});

test("enabledModels loading uses trusted project settings over global settings", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-agent-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-web-access-project-"));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["global/model"] }));
	await mkdir(join(projectDir, ".pi"));
	await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["project/model"] }));

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => true }),
			["project/model"],
		);
		assert.deepEqual(
			loadEnabledModelPatterns({ cwd: projectDir, isProjectTrusted: () => false }),
			["global/model"],
		);
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	}
});

test("summary generation has a hard deadline and preserves caller cancellation", () => {
	assert.equal(SUMMARY_GENERATION_DEADLINE_MS, 30_000);
	assert.match(summarySrc, /Promise\.race\(contenders\)/);
	assert.match(summarySrc, /deadlineController\.abort\(\)/);
	assert.match(summarySrc, /void operation\.then\(\(\) => undefined, \(\) => undefined\)/);
});

async function summaryGenerationDeadline(config) {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-summary-deadline-config-"));
	try {
		if (config !== undefined) await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(configDir)};
				const { getSummaryGenerationDeadlineMs } = await import(${JSON.stringify(indexUrl)});
				console.log("SUMMARY_DEADLINE=" + getSummaryGenerationDeadlineMs());
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
		});
		assert.equal(child.status, 0, child.stderr);
		const matches = [...child.stdout.matchAll(/^SUMMARY_DEADLINE=(\d+)$/gm)];
		assert.equal(matches.length, 1, `Expected one summary deadline in stdout: ${JSON.stringify(child.stdout)}`);
		return Number(matches[0][1]);
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}
}

test("summary generation deadline config defaults, validates, caps, and reaches both workflows", async () => {
	assert.equal(await summaryGenerationDeadline(undefined), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 150_000 }), 150_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 0 }), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 1.5 }), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: "150000" }), 30_000);
	assert.equal(await summaryGenerationDeadline({ summaryGenerationDeadlineMs: 600_001 }), 600_000);
	assert.match(indexSrc, /const MAX_SUMMARY_GENERATION_DEADLINE_MS = 600_000/);
	assert.match(indexSrc, /generateSummaryDraft\(\s*selectedResults,\s*summaryContext,\s*signal,\s*modelOverride,\s*feedback,\s*undefined,\s*getSummaryGenerationDeadlineMs\(\),\s*\)/);
	assert.equal((indexSrc.match(/getSummaryGenerationDeadlineMs\(\)/g) ?? []).length, 3);
	assert.match(readmeSrc, /"summaryGenerationDeadlineMs": 30000/);
	assert.match(readmeSrc, /summaryGenerationDeadlineMs.*capped at `600000`/);
});

test("summary generation no longer uses catalog fallback or first available model", () => {
	assert.doesNotMatch(summarySrc, /getModel/);
	assert.doesNotMatch(indexSrc, /getModel/);
	assert.match(summarySrc, /findModelWithProviderRouting\(ctx\.modelRegistry, spec\.provider, spec\.id\)/);
	assert.match(queryRewriteSrc, /findModelWithProviderRouting\(ctx\.modelRegistry, provider, id\)/);
	assert.match(summarySrc, /modelMatchesEnabledPatterns\(model, enabledModelPatterns\)/);
	assert.doesNotMatch(indexSrc, /defaultSummaryModel = summaryModels\[0\]\.value/);
	assert.match(indexSrc, /modelMatchesEnabledPatterns\(model, enabledModelPatterns\)/);
});

test("summary and query rewrite defaults use the refreshed model order", () => {
	for (const src of [summarySrc, indexSrc]) {
		assert(src.indexOf('id: "claude-haiku-4-5"') < src.indexOf('id: "gpt-5.6-luna"'));
		assert(src.indexOf('id: "gpt-5.6-luna"') < src.indexOf('id: "gpt-5.6-terra"'));
		assert(src.indexOf('id: "gpt-5.6-terra"') < src.indexOf('id: "gemini-3.6-flash"'));
		assert(src.indexOf('id: "gemini-3.6-flash"') < src.indexOf('id: "gpt-5-mini"'));
		assert(src.indexOf('id: "gpt-5-mini"') < src.indexOf('id: "deepseek-v4-flash"'));
		assert.doesNotMatch(src, /gpt-5\.3-codex-spark/);
	}
	assert.match(queryRewriteSrc, /id: "gpt-5-mini"/);
	assert.doesNotMatch(queryRewriteSrc, /gpt-4\.1-mini/);
});
