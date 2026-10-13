import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
const REFUSED_PATH = (path) => `Extraction path ${path} is disabled by the fetch_content same-origin redirect policy because its redirect chain cannot be observed`;
const HOSTED = { fetchRouting: { allowRemoteHostedProviders: true }, tinyfishApiKey: "synthetic-tinyfish", kagiApiKey: "synthetic-kagi", geminiApiKey: "synthetic-gemini" };

// Runs extractContent in a child process with a fresh config dir and a stubbed
// fetch. `routes` maps request URL -> [status, location?]; anything else is 200 text.
async function run({ config, url, options = {}, routes = {}, env = {} }) {
	const root = await mkdtemp(join(tmpdir(), "pi-redirect-policy-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	if (config) await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config), "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const routes = ${JSON.stringify(routes)};
			const fetched = [];
			globalThis.fetch = async (input) => {
				const url = String(input);
				fetched.push(url);
				const route = routes[url];
				if (route) return new Response("", { status: route[0], headers: route[1] ? { location: route[1] } : {} });
				return new Response("page body from " + url, { status: 200, headers: { "content-type": "text/plain" } });
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
			const result = await extractContent(${JSON.stringify(url)}, undefined, { ...${JSON.stringify(options)}, lookup });
			console.log(JSON.stringify({ fetched, result }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: join(root, "home"), USERPROFILE: join(root, "home"), ...env },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("a cross-origin redirect is refused without requesting the other origin or any fallback", async () => {
	const { fetched, result } = await run({
		config: HOSTED,
		url: "https://a.example/start",
		options: { redirects: "same-origin" },
		routes: { "https://a.example/start": [302, "https://b.example/x"] },
	});
	assert.equal(result.error, "Refused cross-origin redirect by fetch_content redirect policy: https://a.example -> https://b.example");
	assert.equal(result.content, "");
	assert.deepEqual(fetched, ["https://a.example/start"]);
});

test("GitHub and YouTube routes are refused by name with no network request", async () => {
	for (const [url, path] of [
		["https://github.com/owner/repo/issues/12", "GitHub issue/PR"],
		["https://github.com/owner/repo", "GitHub repository"],
		["https://www.youtube.com/watch?v=jNQXAC9IVRw", "YouTube"],
	]) {
		const { fetched, result } = await run({ config: { fetchContent: { redirects: "same-origin" } }, url });
		assert.equal(result.error, REFUSED_PATH(path), url);
		assert.deepEqual(fetched, [], url);
	}
});

test("scheme-less YouTube frame requests are refused before yt-dlp runs", async () => {
	const binDir = await mkdtemp(join(tmpdir(), "pi-redirect-policy-bin-"));
	const marker = join(binDir, "yt-dlp-ran");
	await writeFile(join(binDir, "yt-dlp"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
	await chmod(join(binDir, "yt-dlp"), 0o755);
	for (const options of [{ frames: 2 }, { timestamp: "10" }]) {
		const { fetched, result } = await run({
			url: "youtu.be/jNQXAC9IVRw",
			options: { redirects: "same-origin", ...options },
			env: { PATH: `${binDir}${delimiter}${process.env.PATH}` },
		});
		assert.equal(result.error, REFUSED_PATH("YouTube"), JSON.stringify(options));
		assert.deepEqual(fetched, []);
		assert.equal(existsSync(marker), false, `yt-dlp ran for ${JSON.stringify(options)}`);
	}
});

test("a recoverable HTTP failure under the policy tries no hosted or Jina provider", async () => {
	const { fetched, result } = await run({
		config: HOSTED,
		url: "https://a.example/down",
		options: { redirects: "same-origin" },
		routes: { "https://a.example/down": [503] },
	});
	assert.match(result.error, /^HTTP 503/);
	assert.doesNotMatch(result.error, /Fallback options/);
	assert.deepEqual(fetched, ["https://a.example/down"]);
});

test("a routing order without http is refused by name under the policy", async () => {
	const { fetched, result } = await run({
		config: { ...HOSTED, fetchRouting: { providers: ["jina", "tinyfish"], allowRemoteHostedProviders: true } },
		url: "https://a.example/page",
		options: { redirects: "same-origin" },
	});
	assert.equal(result.error, REFUSED_PATH("jina"));
	assert.deepEqual(fetched, []);
});

test("same-origin redirects still return content, with the policy from config alone", async () => {
	const { fetched, result } = await run({
		config: { fetchContent: { redirects: "same-origin" } },
		url: "https://a.example/start",
		routes: { "https://a.example/start": [302, "/final"] },
	});
	assert.equal(result.error, null);
	assert.equal(result.content, "page body from https://a.example/final");
	assert.deepEqual(fetched, ["https://a.example/start", "https://a.example/final"]);
});

test("config enablement refuses a cross-origin redirect without the per-call option", async () => {
	const { fetched, result } = await run({
		config: { fetchContent: { redirects: "same-origin" } },
		url: "https://a.example/start",
		routes: { "https://a.example/start": [302, "https://b.example/x"] },
	});
	assert.equal(result.error, "Refused cross-origin redirect by fetch_content redirect policy: https://a.example -> https://b.example");
	assert.deepEqual(fetched, ["https://a.example/start"]);
});

test("without the policy a cross-origin redirect is still followed", async () => {
	const { fetched, result } = await run({
		url: "https://a.example/start",
		routes: { "https://a.example/start": [302, "https://b.example/x"] },
	});
	assert.equal(result.error, null);
	assert.equal(result.content, "page body from https://b.example/x");
	assert.deepEqual(fetched, ["https://a.example/start", "https://b.example/x"]);
});

test("fetch_content redirects parameter refuses one URL without affecting the others, storage, or the answer model", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-redirect-policy-tool-"));
	const agentDir = join(root, "agent");
	const cacheDir = join(root, "cache");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ workflow: "none", fetchRouting: { providers: ["http"] } }), "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const fetched = [];
			globalThis.fetch = async input => {
				const url = String(input instanceof Request ? input.url : input);
				fetched.push(url);
				if (url === "http://93.184.216.34/moved") return new Response("", { status: 302, headers: { location: "http://93.184.216.35/elsewhere" } });
				return new Response("GOOD_SOURCE " + "g".repeat(200), { headers: { "content-type": "text/plain" } });
			};
			const { default: initialize } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
			const { getResult } = await import(${JSON.stringify(new URL("../storage.ts", import.meta.url).href)});
			const tools = [];
			initialize({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			const pageTexts = [];
			const ctx = { model: { provider: "fixture", id: "model", api: "fixture-api", input: ["text"], contextWindow: 32000 }, scopedModels: [], modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key" }),
				complete: async (_model, context) => {
					pageTexts.push(context.messages[0].content[0].text);
					return { stopReason: "stop", content: [{ type: "text", text: "FIXTURE_ANSWER" }] };
				},
			} };
			const result = await tools.find(t => t.name === "fetch_content").execute("fetch", {
				urls: ["http://93.184.216.34/moved", "http://93.184.216.34/good"], mode: "answer", prompt: "Q?", redirects: "same-origin",
			}, undefined, undefined, ctx);
			const stored = getResult(result.details.responseId);
			console.log(JSON.stringify({ fetched, pageTexts, urls: result.structuredContent.urls, stored: stored.urls.map(u => ({ url: u.url, content: u.content, error: u.error })) }));
		`,
		encoding: "utf8",
		timeout: 20_000,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_ACCESS_CACHE_ROOT: cacheDir, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
	});
	assert.equal(child.status, 0, child.stderr);
	const { fetched, pageTexts, urls, stored } = JSON.parse(child.stdout.trim().split("\n").at(-1));
	const refusal = "Refused cross-origin redirect by fetch_content redirect policy: http://93.184.216.34 -> http://93.184.216.35";
	assert.deepEqual(fetched.sort(), ["http://93.184.216.34/good", "http://93.184.216.34/moved"]);
	assert.equal(pageTexts.length, 1);
	assert.match(pageTexts[0], /GOOD_SOURCE/);
	assert.deepEqual(urls.map(u => [u.error ?? null, u.content]), [[refusal, ""], [null, "FIXTURE_ANSWER"]]);
	assert.deepEqual(stored[0], { url: "http://93.184.216.34/moved", content: "", error: refusal });
	assert.match(stored[1].content, /^GOOD_SOURCE/);
});
