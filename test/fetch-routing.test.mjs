import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
const featureConfigUrl = new URL("../feature-config.ts", import.meta.url).href;

function cleanProviderEnv(root) {
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
	for (const key of [
		"CRAWL4AI_BASE_URL", "CRAWL4AI_API_TOKEN", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY",
		"SEARCH1API_KEY", "SEARCH1API_API_KEY", "QUERIT_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY",
		"BRIGHTDATA_API_KEY", "BRIGHTDATA_UNLOCKER_ZONE", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY",
	]) delete childEnv[key];
	return childEnv;
}

async function runExtract(config, { jinaFails = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const childEnv = cleanProviderEnv(root);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text.startsWith("https://r.jina.ai/") && !${jinaFails}) {
					return new Response("Markdown Content:\\n# Routed\\n\\n" + "Jina routed content. ".repeat(12), { status: 200 });
				}
				return new Response("blocked", { status: 403 });
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/routed", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

async function runTypedExtract(config, contentType) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-typed-"));
	await writeFile(join(root, "web-search.json"), typeof config === "string" ? config : JSON.stringify(config) + "\n", "utf8");
	const childEnv = cleanProviderEnv(root);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/typed") {
					return new Response("typed", { status: 200, headers: { "content-type": ${JSON.stringify(contentType)} } });
				}
				if (text.startsWith("https://r.jina.ai/")) {
					return new Response("Markdown Content:\\n# Bypassed\\n\\n" + "content ".repeat(80), { status: 200 });
				}
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/typed", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("fetchRouting.providers can put Jina first after explicit remote-hosted opt-in", async () => {
	const output = await runExtract({ fetchRouting: { providers: ["jina", "http"], allowRemoteHostedProviders: true } });
	assert.deepEqual(output.calls, [
		"https://example.com/routed",
		"https://r.jina.ai/https://example.com/routed",
	]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("remote hosted fetch providers are disabled by default", async () => {
	const output = await runExtract({});
	assert.deepEqual(output.calls, ["https://example.com/routed"]);
	assert.match(output.result.error, /HTTP 403/);
});

test("fetchRouting without providers uses the default order when remote hosted providers are allowed", async () => {
	const output = await runExtract({ fetchRouting: { allowRemoteHostedProviders: true } });
	assert.deepEqual(output.calls, [
		"https://example.com/routed",
		"https://r.jina.ai/https://example.com/routed",
	]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

const JINA_HINT = "Enable the keyless Jina Reader fallback";
const JINA_PRIVACY = "target URLs are fetched through Jina's infrastructure";

test("blocked-page guidance enables Jina with only the remote-hosted opt-in when Jina is already routed", async () => {
	const output = await runExtract({});
	const hint = output.result.error.split("\n").find(line => line.includes(JINA_HINT));
	assert.ok(hint, output.result.error);
	assert.match(hint, /set fetchRouting\.allowRemoteHostedProviders to true in .*web-search\.json/);
	assert.match(hint, /Jina is already in your fetch provider order/);
	assert.match(hint, /also allows the other hosted providers/);
	assert.ok(hint.includes(JINA_PRIVACY), hint);
	assert.doesNotMatch(hint, /"providers"|add "jina"/);
});

test("blocked-page guidance asks to add Jina to a custom provider list without replacing it", async () => {
	const gated = await runExtract({ fetchRouting: { providers: ["http", "firecrawl"] } });
	const gatedHint = gated.result.error.split("\n").find(line => line.includes(JINA_HINT));
	assert.match(gatedHint, /add "jina" to your existing fetchRouting\.providers and set fetchRouting\.allowRemoteHostedProviders to true/);
	assert.ok(gatedHint.includes(JINA_PRIVACY), gatedHint);

	const allowed = await runExtract({ fetchRouting: { providers: ["http", "firecrawl"], allowRemoteHostedProviders: true } });
	const allowedHint = allowed.result.error.split("\n").find(line => line.includes(JINA_HINT));
	assert.match(allowedHint, /add "jina" to your existing fetchRouting\.providers in /);
	assert.doesNotMatch(allowedHint, /allowRemoteHostedProviders/);
	assert.ok(allowedHint.includes(JINA_PRIVACY), allowedHint);
});

test("blocked-page guidance does not suggest enabling Jina after Jina was attempted", async () => {
	const output = await runExtract({ fetchRouting: { providers: ["http", "jina"], allowRemoteHostedProviders: true } }, { jinaFails: true });
	assert.ok(output.calls.includes("https://r.jina.ai/https://example.com/routed"));
	assert.match(output.result.error, /HTTP 403/);
	assert.match(output.result.error, /Fallback options:/);
	assert.ok(!output.result.error.includes(JINA_HINT), output.result.error);
});

test("disabled image fetching does not fall through to hosted providers", async () => {
	const output = await runTypedExtract({ image: { enabled: false }, fetchRouting: { providers: ["http", "jina"], allowRemoteHostedProviders: true } }, "image/png");
	assert.deepEqual(output.calls, ["https://example.com/typed"]);
	assert.match(output.result.error, /Image fetching is disabled by image\.enabled/);
});

test("disabled PDF extraction does not fall through to hosted providers", async () => {
	const output = await runTypedExtract({ pdf: { enabled: false }, fetchRouting: { providers: ["http", "jina"], allowRemoteHostedProviders: true } }, "application/pdf");
	assert.deepEqual(output.calls, ["https://example.com/typed"]);
	assert.match(output.result.error, /PDF extraction is disabled by pdf\.enabled/);
});

test("malformed config returns a parse error without hosted fallback", async () => {
	const output = await runTypedExtract("{", "image/png");
	assert.deepEqual(output.calls, []);
	assert.match(output.result.error, /Failed to parse .*web-search\.json/);
});

test("image attachment gate suppresses malformed config", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-feature-config-"));
	await writeFile(join(root, "web-search.json"), "{", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(root)};
			const { canAttachImages, isImageEnabled } = await import(${JSON.stringify(featureConfigUrl)});
			let parseError = "";
			try { isImageEnabled(); } catch (err) { parseError = err instanceof Error ? err.message : String(err); }
			console.log(JSON.stringify({ canAttach: canAttachImages(), parseError }));
		`,
		encoding: "utf8",
		env: cleanProviderEnv(root),
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.canAttach, false);
	assert.match(output.parseError, /Failed to parse .*web-search\.json/);
});

test("Ollama Web Fetch is disabled for remote URLs without hosted-provider opt-in", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-ollama-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify({ ollamaApiKey: "test-key", fetchRouting: { providers: ["ollama", "http"] } }) + "\n", "utf8");
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
	delete childEnv.OLLAMA_API_KEY;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/routed") return new Response("blocked", { status: 403 });
				if (text === "https://ollama.com/api/web_fetch") return new Response(JSON.stringify({ title: "Ollama", content: "remote content" }), { status: 200 });
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/routed", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/routed"]);
	assert.match(output.result.error, /HTTP 403/);
});

test("hosted providers cannot bypass redirect policy validation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-redirect-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify({ fetchRouting: { providers: ["jina"], allowRemoteHostedProviders: true } }) + "\n", "utf8");
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root };
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/redirect") {
					return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
				}
				if (text.startsWith("https://r.jina.ai/")) {
					return new Response("Markdown Content:\\n# Bypassed\\n\\n" + "content ".repeat(80), { status: 200 });
				}
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/redirect", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/redirect"]);
	assert.match(output.result.error, /Blocked internal address/);
});

const readableFiller = "<p>" + "Example.com needs to review the security of your connection before proceeding with this readable article text. ".repeat(8) + "</p>";
const genericMomentPage = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><article><h1>Just a moment...</h1>${readableFiller}${readableFiller}</article></body></html>`;
const cloudflareChallengePage = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><article><h1>Verifying you are human</h1>${readableFiller}${readableFiller}</article><script>(function(){window._cf_chl_opt={cvId:'3',cType:'managed'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=abc';document.head.appendChild(a);}());</script></body></html>`;

async function runChallengeExtract(config, { body, headers = {}, mode } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-challenge-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/challenge") {
					return new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...${JSON.stringify(headers)} } });
				}
				if (text.startsWith("https://r.jina.ai/")) {
					return new Response("Markdown Content:\\n# Routed\\n\\n" + "Jina routed content. ".repeat(12), { status: 200 });
				}
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/challenge", undefined, { ${mode ? `mode: ${JSON.stringify(mode)}, ` : ""}lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`,
		encoding: "utf8",
		env: cleanProviderEnv(root),
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const challengeFallbackRouting = { fetchRouting: { providers: ["http", "jina"], allowRemoteHostedProviders: true } };

test("HTTP 200 with cf-mitigated: challenge falls back to configured providers", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: genericMomentPage, headers: { "cf-mitigated": "challenge" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge", "https://r.jina.ai/https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("HTTP 200 cf-mitigated: challenge falls back even when the response is not labeled HTML", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: "Just a moment...", headers: { "content-type": "text/plain", "cf-mitigated": "challenge" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge", "https://r.jina.ai/https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("Cloudflare body markers in a non-HTML response are returned as content", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: cloudflareChallengePage, headers: { "content-type": "text/plain" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.content, cloudflareChallengePage);
});

test("HTTP 200 Cloudflare challenge body signature falls back to configured providers", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: cloudflareChallengePage });
	assert.deepEqual(output.calls, ["https://example.com/challenge", "https://r.jina.ai/https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("generic Just a moment text alone is not treated as a challenge", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: genericMomentPage });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.match(output.result.content, /readable article text/);
});

test("HTTP-only routing reports a Cloudflare challenge as an HTTP extraction failure", async () => {
	const output = await runChallengeExtract({}, { body: cloudflareChallengePage, headers: { "cf-mitigated": "challenge" } });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.match(output.result.error, /^HTTP 200: Blocked by Cloudflare challenge page/);
	assert.equal(output.result.content, "");
});

test("raw mode returns Cloudflare challenge bodies verbatim without fallback", async () => {
	const output = await runChallengeExtract(challengeFallbackRouting, { body: cloudflareChallengePage, headers: { "cf-mitigated": "challenge" }, mode: "raw" });
	assert.deepEqual(output.calls, ["https://example.com/challenge"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.content, cloudflareChallengePage);
});
