import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-key-pool-"));
	const agentDir = join(home, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return { home, agentDir };
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"TAVILY_API_KEY",
		"TAVILY_API_KEY_INDEX",
		"TAVILY_API_KEY_1",
		"TAVILY_API_KEY_2",
		"TAVILY_API_KEY_3",
		"TAVILY_API_KEY_5",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("plain TAVILY_API_KEY environment still resolves exactly like before the key pool", async () => {
	const { home, agentDir } = await createHome({});
	const child = runChild(`
		const { isTavilyAvailable, searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
			return new Response(JSON.stringify({ results: [{ title: "Tavily", url: "https://example.com/tavily", content: "result" }] }), { status: 200 });
		};
		console.log(JSON.stringify({
			available: isTavilyAvailable(),
			calls,
		}));
		await searchWithTavily("tavily", { numResults: 1 });
		console.log(JSON.stringify({ calls, availableAfter: isTavilyAvailable() }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY: "tavily-solo-key" });

	assert.equal(child.status, 0, child.stderr);
	const [before, after] = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(before.available, true);
	assert.equal(after.availableAfter, true);
	assert.equal(after.calls[0].headers.authorization, "Bearer tavily-solo-key");
});

test("key pool advances to the next key on quota failures and reports the last error when exhausted", async () => {
	const { home, agentDir } = await createHome({});
	const child = runChild(`
		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const headers = Object.fromEntries(new Headers(init.headers));
			calls.push({ status: null, authorization: headers.authorization });
			if (String(headers.authorization).endsWith("tavily-pool-key-3")) {
				return new Response(JSON.stringify({ results: [{ title: "Tavily", url: "https://example.com/tavily", content: "result" }] }), { status: 200 });
			}
			return new Response("{}", { status: 429 });
		};
		try {
			const result = await searchWithTavily("tavily", { numResults: 1 });
			console.log(JSON.stringify({ ok: true, keys: calls.map((call) => call.authorization.replace("Bearer ", "")), results: result.results.length }));
		} catch (err) {
			console.log(JSON.stringify({ ok: false, error: String(err.message), keys: calls.map((call) => call.authorization.replace("Bearer ", "")) }));
		}
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY_1: "tavily-pool-key-1", TAVILY_API_KEY_2: "tavily-pool-key-2", TAVILY_API_KEY_3: "tavily-pool-key-3" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, true);
	assert.deepEqual(output.keys, ["tavily-pool-key-1", "tavily-pool-key-2", "tavily-pool-key-3"]);
	assert.equal(output.results, 1);
});

test("TAVILY_API_KEY_INDEX chooses the pool slot that is tried first", async () => {
	const { home, agentDir } = await createHome({});
	const child = runChild(`
		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const headers = Object.fromEntries(new Headers(init.headers));
			calls.push(headers.authorization.replace("Bearer ", ""));
			if (String(headers.authorization).endsWith("tavily-pool-key-2")) {
				return new Response(JSON.stringify({ results: [{ title: "Tavily", url: "https://example.com/tavily", content: "result" }] }), { status: 200 });
			}
			return new Response("{}", { status: 429 });
		};
		const result = await searchWithTavily("tavily", { numResults: 1 });
		console.log(JSON.stringify({ ok: true, keys: calls, results: result.results.length }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY_1: "tavily-pool-key-1", TAVILY_API_KEY_2: "tavily-pool-key-2", TAVILY_API_KEY_3: "tavily-pool-key-3", TAVILY_API_KEY_INDEX: "2" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, true);
	assert.equal(output.keys[0], "tavily-pool-key-2");
	assert.equal(output.results, 1);
});

test("TAVILY_API_KEY_INDEX selects the numbered slot when the pool has gaps", async () => {
	const { home, agentDir } = await createHome({});
	const child = runChild(`
		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const headers = Object.fromEntries(new Headers(init.headers));
			calls.push(headers.authorization.replace("Bearer ", ""));
			return new Response(JSON.stringify({ results: [{ title: "Tavily", url: "https://example.com/tavily", content: "result" }] }), { status: 200 });
		};
		const result = await searchWithTavily("tavily", { numResults: 1 });
		console.log(JSON.stringify({ ok: true, keys: calls, results: result.results.length }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY_1: "tavily-pool-key-1", TAVILY_API_KEY_5: "tavily-pool-key-5", TAVILY_API_KEY_INDEX: "5" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, true);
	assert.deepEqual(output.keys, ["tavily-pool-key-5"]);
	assert.equal(output.results, 1);
});

test("non-quota failures do not consume additional pool keys", async () => {
	const { home, agentDir } = await createHome({});
	const child = runChild(`
		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		let requestCount = 0;
		globalThis.fetch = async () => {
			requestCount += 1;
			return new Response("{}", { status: 400 });
		};
		try {
			await searchWithTavily("tavily", { numResults: 1 });
		} catch (err) {
			console.log(JSON.stringify({ error: String(err.message), requestCount }));
		}
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY_1: "tavily-pool-key-1", TAVILY_API_KEY_2: "tavily-pool-key-2" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Tavily API error 400/);
	assert.equal(output.requestCount, 1);
});

test("key-pool sources keep isTavilyAvailable true when no solo credential is configured", async () => {
	const { home, agentDir } = await createHome({});
	const child = runChild(`
		const { isTavilyAvailable } = await import(${JSON.stringify(tavilyModuleUrl)});
		console.log(JSON.stringify({ available: isTavilyAvailable() }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, TAVILY_API_KEY_1: "tavily-pool-key-1", TAVILY_API_KEY_2: "tavily-pool-key-2" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
});
