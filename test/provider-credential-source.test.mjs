import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;
const geminiApiModuleUrl = new URL("../gemini-api.ts", import.meta.url).href;
const openaiModuleUrl = new URL("../openai-search.ts", import.meta.url).href;
const parallelModuleUrl = new URL("../parallel.ts", import.meta.url).href;
const tinyfishModuleUrl = new URL("../tinyfish.ts", import.meta.url).href;
const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;
const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-credential-source-"));
	const agentDir = join(home, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return { home, agentDir };
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"BRAVE_API_KEY",
		"CLOUDFLARE_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"OPENAI_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"SEARCH1API_KEY",
		"SEARCHINFINITY_API_KEY",
		"QUERIT_API_KEY",
		"PERPLEXITY_API_KEY",
		"TAVILY_API_KEY",
		"JINA_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("previously unsupported providers resolve explicit env and command sources lazily", async () => {
	const tavilyMarker = join(await mkdtemp(join(tmpdir(), "pi-web-access-credential-marker-")), "tavily-ran");
	const openaiMarker = join(await mkdtemp(join(tmpdir(), "pi-web-access-credential-marker-")), "openai-ran");
	const { home, agentDir } = await createHome({
		braveApiKey: "${BRAVE_SCOPED_KEY}",
		openaiApiKey: `!touch ${openaiMarker} && printf openai-command-key`,
		tavilyApiKey: `!touch ${tavilyMarker} && printf tavily-command-key`,
	});
	const child = runChild(`
		import { existsSync } from "node:fs";
		const { isBraveAvailable, searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const { isOpenAISearchAvailable, searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const { isTavilyAvailable, searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "result" }] } }), { status: 200 });
		};
		const availableBefore = {
			brave: isBraveAvailable(),
			openai: await isOpenAISearchAvailable(),
			tavily: isTavilyAvailable(),
			openaiMarker: existsSync(${JSON.stringify(openaiMarker)}),
			tavilyMarker: existsSync(${JSON.stringify(tavilyMarker)}),
		};
		await searchWithBrave("brave", { numResults: 1 });
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({
				output: [
					{ type: "web_search_call", action: { sources: [] } },
					{ type: "message", content: [{ type: "output_text", text: "OpenAI answer" }] },
				],
			}), { status: 200 });
		};
		await searchWithOpenAI("openai", { numResults: 1 });
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({ results: [{ title: "Tavily", url: "https://example.com/tavily", content: "result" }] }), { status: 200 });
		};
		await searchWithTavily("tavily", { numResults: 1 });
		console.log(JSON.stringify({
			availableBefore,
			openaiMarkerAfter: existsSync(${JSON.stringify(openaiMarker)}),
			tavilyMarkerAfter: existsSync(${JSON.stringify(tavilyMarker)}),
			calls,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		BRAVE_SCOPED_KEY: "brave-scoped-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.availableBefore, {
		brave: true,
		openai: true,
		tavily: true,
		openaiMarker: false,
		tavilyMarker: false,
	});
	assert.equal(output.openaiMarkerAfter, true);
	assert.equal(output.tavilyMarkerAfter, true);
	assert.equal(output.calls[0].headers["x-subscription-token"], "brave-scoped-key");
	assert.equal(output.calls[1].headers.authorization, "Bearer openai-command-key");
	assert.equal(output.calls[2].headers.authorization, "Bearer tavily-command-key");
});

test("provider requests can resolve credentials through an inherited 1Password service-account token", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-fake-op-"));
	const fakeOp = join(root, "fake-op.mjs");
	await writeFile(fakeOp, `
		if (process.argv.slice(2).join(" ") !== "read op://Automation/Brave/credential") process.exit(2);
		if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== "synthetic-service-account-token") process.exit(3);
		if (process.env.UNRELATED_SECRET !== undefined) process.exit(4);
		process.stdout.write("synthetic-brave-key");
	`, "utf8");
	const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeOp)} read ${JSON.stringify("op://Automation/Brave/credential")}`;
	const { home, agentDir } = await createHome({ braveApiKey: `!${command}` });
	const child = runChild(`
		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		let request;
		globalThis.fetch = async (url, init = {}) => {
			request = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: String(init.body ?? "") };
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};
		await searchWithBrave("query", { numResults: 1 });
		console.log(JSON.stringify({ request }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		OP_SERVICE_ACCOUNT_TOKEN: "synthetic-service-account-token",
		UNRELATED_SECRET: "must-not-reach-command",
	});

	assert.equal(child.status, 0, child.stderr);
	const { request } = JSON.parse(child.stdout.trim());
	assert.equal(request.headers["x-subscription-token"], "synthetic-brave-key");
	assert.equal(JSON.stringify(request).includes("synthetic-service-account-token"), false);
});

test("provider API errors redact resolved credential-source values", async () => {
	const { home, agentDir } = await createHome({
		braveApiKey: "${BRAVE_SCOPED_KEY}",
		cloudflareApiKey: "${CLOUDFLARE_SCOPED_KEY}",
		geminiBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
		openaiApiKey: "!printf openai-redaction-secret",
		parallelApiKey: "!printf parallel-redaction-secret",
		tinyfishApiKey: "!printf tinyfish-redaction-secret",
		perplexityApiKey: "!printf perplexity-redaction-secret",
		tavilyApiKey: "!printf tavily-redaction-secret",
	});
	const child = runChild(`
		const modules = {
			brave: await import(${JSON.stringify(braveModuleUrl)}),
			geminiApi: await import(${JSON.stringify(geminiApiModuleUrl)}),
			openai: await import(${JSON.stringify(openaiModuleUrl)}),
			parallel: await import(${JSON.stringify(parallelModuleUrl)}),
			tinyfish: await import(${JSON.stringify(tinyfishModuleUrl)}),
			perplexity: await import(${JSON.stringify(perplexityModuleUrl)}),
			tavily: await import(${JSON.stringify(tavilyModuleUrl)}),
		};
		const attempts = [
			["brave", "brave-redaction-secret", () => modules.brave.searchWithBrave("query")],
			["openai", "openai-redaction-secret", () => modules.openai.searchWithOpenAI("query")],
			["parallel", "parallel-redaction-secret", () => modules.parallel.searchWithParallel("query")],
			["tinyfish", "tinyfish-redaction-secret", () => modules.tinyfish.searchWithTinyFish("query")],
			["perplexity", "perplexity-redaction-secret", () => modules.perplexity.searchWithPerplexity("query")],
			["tavily", "tavily-redaction-secret", () => modules.tavily.searchWithTavily("query")],
			["cloudflare", "cf-redaction-secret", () => modules.geminiApi.queryGeminiApiWithVideo("prompt", "files/synthetic")],
		];
		const messages = {};
		for (const [name, secret, run] of attempts) {
			globalThis.fetch = async () => new Response(JSON.stringify({ error: secret }), { status: 400 });
			try {
				await run();
				messages[name] = "NO_ERROR";
			} catch (error) {
				messages[name] = error instanceof Error ? error.message : String(error);
			}
		}
		console.log(JSON.stringify({ messages, secrets: Object.fromEntries(attempts.map(([name, secret]) => [name, secret])) }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		BRAVE_SCOPED_KEY: "brave-redaction-secret",
		CLOUDFLARE_SCOPED_KEY: "cf-redaction-secret",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	for (const [provider, message] of Object.entries(output.messages)) {
		assert.notEqual(message, "NO_ERROR", provider);
		assert.match(message, /\[redacted\]/, provider);
		assert.equal(message.includes(output.secrets[provider]), false, provider);
	}
});

test("Cloudflare gateway response redacts the credential used by the request", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-cloudflare-redaction-"));
	const countPath = join(root, "count");
	const resolverPath = join(root, "cloudflare-key.mjs");
	await writeFile(resolverPath, `
		import { existsSync, readFileSync, writeFileSync } from "node:fs";
		const countPath = ${JSON.stringify(countPath)};
		const current = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) : 0;
		const next = current + 1;
		writeFileSync(countPath, String(next));
		process.stdout.write("cf-rotating-secret-" + next);
	`, "utf8");
	const { home, agentDir } = await createHome({
		cloudflareApiKey: `!${JSON.stringify(process.execPath)} ${JSON.stringify(resolverPath)}`,
		geminiBaseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
	});
	const child = runChild(`
		import { readFileSync } from "node:fs";
		const { queryGeminiApiWithVideo } = await import(${JSON.stringify(geminiApiModuleUrl)});
		let leaked = false;
		let redacted = false;
		globalThis.fetch = async (url, init = {}) => {
			const sent = new Headers(init.headers).get("cf-aig-authorization")?.replace(/^Bearer /, "") ?? "missing";
			return new Response(JSON.stringify({ error: sent }), { status: 400 });
		};
		try {
			await queryGeminiApiWithVideo("prompt", "files/synthetic");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			leaked = message.includes("cf-rotating-secret-1");
			redacted = message.includes("[redacted]");
		}
		console.log(JSON.stringify({ leaked, redacted, count: readFileSync(${JSON.stringify(countPath)}, "utf8") }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output, { leaked: false, redacted: true, count: "1" });
});
