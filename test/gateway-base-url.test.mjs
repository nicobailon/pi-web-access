import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const openaiUrl = new URL("../openai-search.ts", import.meta.url).href;
const perplexityUrl = new URL("../perplexity.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"OPENAI_SEARCH_MODEL",
		"PERPLEXITY_API_KEY",
		"PERPLEXITY_BASE_URL",
		"PERPLEXITY_MODEL",
	]) {
		delete childEnv[key];
	}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete childEnv[key];
		} else {
			childEnv[key] = value;
		}
	}
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
}

test("OpenAI Responses search routes through OPENAI_BASE_URL with an overridden model", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-openai-base-url-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	// Config supplies a base URL + model; env must win over config for the base URL.
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({
			openaiApiKey: "sk-test",
			openaiBaseUrl: "https://config.example.com/v1/",
			openaiSearchModel: "azure/openai/gpt-5.5",
		}) + "\n",
		"utf8",
	);

	const child = runChild(
		`
		let capturedUrl = "";
		let capturedModel = "";
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedModel = JSON.parse(init.body).model;
			// Minimal SSE completion the parser accepts.
			const body = 'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ok","annotations":[]}]}]}}\\n\\ndata: [DONE]\\n\\n';
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const { searchWithOpenAI } = await import(${JSON.stringify(openaiUrl)});
		const res = await searchWithOpenAI("hello");
		console.log(JSON.stringify({ capturedUrl, capturedModel, answer: res.answer }));
	`,
		{
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CONFIG_HOME: undefined,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
			OPENAI_BASE_URL: "https://gateway.example.com/v1",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout);
	assert.equal(out.capturedUrl, "https://gateway.example.com/v1/responses");
	assert.equal(out.capturedModel, "azure/openai/gpt-5.5");
	assert.equal(out.answer, "ok");
});

test("OpenAI Responses search defaults to the OpenAI endpoint and model when unset", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-openai-default-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ openaiApiKey: "sk-test" }) + "\n", "utf8");

	const child = runChild(
		`
		let capturedUrl = "";
		let capturedModel = "";
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedModel = JSON.parse(init.body).model;
			const body = 'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ok","annotations":[]}]}]}}\\n\\ndata: [DONE]\\n\\n';
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const { searchWithOpenAI } = await import(${JSON.stringify(openaiUrl)});
		await searchWithOpenAI("hello");
		console.log(JSON.stringify({ capturedUrl, capturedModel }));
	`,
		{
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CONFIG_HOME: undefined,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout);
	assert.equal(out.capturedUrl, "https://api.openai.com/v1/responses");
	assert.equal(out.capturedModel, "gpt-5.4");
});

test("Perplexity search routes through PERPLEXITY_BASE_URL with an overridden model", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-pplx-base-url-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({
			perplexityApiKey: "pplx-test",
			perplexityBaseUrl: "https://config.example.com/",
			perplexityModel: "perplexity/perplexity/sonar",
		}) + "\n",
		"utf8",
	);

	const child = runChild(
		`
		let capturedUrl = "";
		let capturedModel = "";
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedModel = JSON.parse(init.body).model;
			return new Response(JSON.stringify({
				choices: [{ message: { content: "ok" } }],
				citations: [],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityUrl)});
		const res = await searchWithPerplexity("hello");
		console.log(JSON.stringify({ capturedUrl, capturedModel, answer: res.answer }));
	`,
		{
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CONFIG_HOME: undefined,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
			PERPLEXITY_BASE_URL: "https://gateway.example.com/v1",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout);
	assert.equal(out.capturedUrl, "https://gateway.example.com/v1/chat/completions");
	assert.equal(out.capturedModel, "perplexity/perplexity/sonar");
	assert.equal(out.answer, "ok");
});

test("Perplexity search defaults to the Perplexity endpoint and sonar model when unset", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-pplx-default-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ perplexityApiKey: "pplx-test" }) + "\n", "utf8");

	const child = runChild(
		`
		let capturedUrl = "";
		let capturedModel = "";
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedModel = JSON.parse(init.body).model;
			return new Response(JSON.stringify({
				choices: [{ message: { content: "ok" } }],
				citations: [],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityUrl)});
		await searchWithPerplexity("hello");
		console.log(JSON.stringify({ capturedUrl, capturedModel }));
	`,
		{
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CONFIG_HOME: undefined,
			HOME: join(root, "home"),
			USERPROFILE: join(root, "home"),
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout);
	assert.equal(out.capturedUrl, "https://api.perplexity.ai/chat/completions");
	assert.equal(out.capturedModel, "sonar");
});
