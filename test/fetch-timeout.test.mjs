import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;

function cleanEnv(root) {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: root,
		HOME: root,
		USERPROFILE: root,
	};
}

async function writeConfig(root, config) {
	if (config === undefined) return;
	await writeFile(join(root, "web-search.json"), typeof config === "string" ? config : JSON.stringify(config), "utf8");
}

async function runResolver(config, options) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-timeout-resolver-"));
	await writeConfig(root, config);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { resolveFetchTimeoutMs } = await import(${JSON.stringify(extractUrl)});
			try {
				console.log(JSON.stringify({ timeoutMs: resolveFetchTimeoutMs(${JSON.stringify(options ?? {})}) }));
			} catch (err) {
				console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
		`,
		encoding: "utf8",
		env: cleanEnv(root),
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

async function runJina(config, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-timeout-jina-"));
	await writeConfig(root, config);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			const httpTimeoutCalls = [];
			const timeoutCalls = [];
			globalThis.fetch = async (url) => {
				const text = String(url);
				calls.push(text);
				if (text === "https://example.com/routed") return new Response("blocked", { status: 403 });
				if (text.startsWith("https://r.jina.ai/")) {
					return new Response("Markdown Content:\\n# Routed\\n\\n" + "Jina routed content. ".repeat(12), { status: 200 });
				}
				throw new Error("Unexpected fetch " + text);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = (callback, ms, ...args) => {
				httpTimeoutCalls.push(ms);
				return originalSetTimeout(callback, ms, ...args);
			};
			const originalTimeout = AbortSignal.timeout;
			AbortSignal.timeout = (ms) => {
				timeoutCalls.push(ms);
				return originalTimeout(ms);
			};
			const result = await extractContent(
				"https://example.com/routed",
				undefined,
				{ ...${JSON.stringify(options)}, lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
			);
			console.log(JSON.stringify({ calls, httpTimeoutCalls, timeoutCalls, result }));
		`,
		encoding: "utf8",
		env: cleanEnv(root),
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const jinaConfig = (timeout) => ({
	fetch: { timeout },
	fetchRouting: { providers: ["jina"], allowRemoteHostedProviders: true },
});

test("fetch.timeout defaults to the direct HTTP/Jina 30 second budget", async () => {
	assert.deepEqual(await runResolver(undefined), { timeoutMs: 30000 });
	assert.deepEqual(await runResolver({}), { timeoutMs: 30000 });
});

test("fetch.timeout accepts seconds and rounds fractional milliseconds up", async () => {
	assert.deepEqual(await runResolver({ fetch: { timeout: 2 } }), { timeoutMs: 2000 });
	assert.deepEqual(await runResolver({ fetch: { timeout: 1.2345 } }), { timeoutMs: 1235 });
});

test("invalid fetch.timeout values fail closed with the config path", async () => {
	for (const timeout of [0, -1, null, "2", {}]) {
		const output = await runResolver({ fetch: { timeout } });
		assert.match(output.error, /Invalid fetch\.timeout .*web-search\.json/);
	}
});

test("fetch.timeout rejects seconds that overflow safe millisecond conversion", async () => {
	assert.deepEqual(await runResolver({ fetch: { timeout: 2147483.647 } }), { timeoutMs: 2147483647 });
	for (const timeout of [2147483.648, 1e308, Number.MAX_SAFE_INTEGER]) {
		const output = await runResolver({ fetch: { timeout } });
		assert.match(output.error, /Invalid fetch\.timeout .*web-search\.json/);
		assert.match(output.error, /finite safe integer/);
		assert.match(output.error, /2147483647/);
	}
});

test("malformed web-search.json fails closed with the config path", async () => {
	const output = await runResolver("{");
	assert.match(output.error, /Failed to parse .*web-search\.json/);
});

test("Jina receives the resolved configured timeout budget", async () => {
	const output = await runJina(jinaConfig(1.25));
	assert.deepEqual(output.calls, ["https://r.jina.ai/https://example.com/routed"]);
	assert.deepEqual(output.httpTimeoutCalls, []);
	assert.deepEqual(output.timeoutCalls, [1250]);
	assert.equal(output.result.error, null);
});

test("explicit timeoutMs takes precedence over invalid fetch.timeout config", async () => {
	const output = await runJina(jinaConfig(0), { timeoutMs: 7 });
	assert.deepEqual(output.timeoutCalls, [7]);
	assert.equal(output.result.error, null);
});

test("Jina does not swallow invalid timeout configuration", async () => {
	const output = await runJina(jinaConfig(0));
	assert.deepEqual(output.calls, []);
	assert.match(output.result.error, /Invalid fetch\.timeout .*web-search\.json/);
});

test("positive sub-millisecond fetch.timeout values use a nonzero budget", async () => {
	const output = await runJina(jinaConfig(0.0005));
	assert.deepEqual(output.timeoutCalls, [1]);
	assert.equal(output.result.error, null);
});
