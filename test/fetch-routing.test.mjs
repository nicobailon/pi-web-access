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

async function runExtract(config, target = "https://example.com/routed") {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-routing-"));
	if (config !== undefined) {
		await writeFile(join(root, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	}
	const childEnv = cleanProviderEnv(root);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text.startsWith("https://r.jina.ai/")) {
					return new Response("Markdown Content:\\n# Routed\\n\\n" + "Jina routed content. ".repeat(12), { status: 200 });
				}
				return new Response("blocked", { status: 403 });
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent(${JSON.stringify(target)}, undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
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
	assert.deepEqual(output.calls, ["https://r.jina.ai/https://example.com/routed"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("fetchRouting.providers can use only a hosted provider", async () => {
	const output = await runExtract({ fetchRouting: { providers: ["jina"], allowRemoteHostedProviders: true } });
	assert.deepEqual(output.calls, ["https://r.jina.ai/https://example.com/routed"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Routed");
});

test("absent config retains direct HTTP as the first provider", async () => {
	const output = await runExtract(undefined);
	assert.deepEqual(output.calls, ["https://example.com/routed"]);
	assert.match(output.result.error, /HTTP 403/);
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

test("hosted providers cannot bypass blocked-target validation", async () => {
	const output = await runExtract({ fetchRouting: { providers: ["jina"], allowRemoteHostedProviders: true } }, "http://127.0.0.1/admin");
	assert.deepEqual(output.calls, []);
	assert.match(output.result.error, /Blocked internal address/);
});
