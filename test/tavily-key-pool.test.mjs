import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;
const activityModuleUrl = new URL("../activity.ts", import.meta.url).href;

// Runs one search in a child process. Requests with `succeedWith` succeed; every other key gets `failStatus`.
async function search({ config = {}, env, succeedWith, failStatus = 429 }) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-key-pool-"));
	const agentDir = join(home, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config), "utf8");
	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) if (/^(TAVILY_API_KEY|PI_WEB_ACCESS_TEST_MISSING_TAVILY_KEY)/.test(key)) delete childEnv[key];
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		env: { ...childEnv, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, ...env },
		input: `
			const { isTavilyAvailable, searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
			const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
			const keys = [];
			globalThis.fetch = async (url, init = {}) => {
				const key = new Headers(init.headers).get("authorization").replace("Bearer ", "");
				keys.push(key);
				if (key === ${JSON.stringify(succeedWith)}) {
					return Response.json({ results: [{ title: "Tavily", url: "https://example.com/tavily", content: "result" }] });
				}
				return new Response("abort this quota-limited request", { status: ${failStatus} });
			};
			const available = isTavilyAvailable();
			let results, error;
			try {
				results = (await searchWithTavily("tavily", { numResults: 1 })).results.length;
			} catch (err) { error = err.message; }
			console.log(JSON.stringify({ available, keys, results, error, activity: activityMonitor.getEntries() }));
		`,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("a plain TAVILY_API_KEY works alone and out-of-range pool slots are ignored", async () => {
	const out = await search({ env: { TAVILY_API_KEY: "solo", TAVILY_API_KEY_25: "out-of-range" }, succeedWith: "solo" });
	assert.equal(out.available, true);
	assert.deepEqual(out.keys, ["solo"]);
	assert.equal(out.results, 1);
});

test("pool keys alone make Tavily available and fail over on quota responses", async () => {
	const out = await search({ env: { TAVILY_API_KEY_1: "key-1", TAVILY_API_KEY_2: "key-2", TAVILY_API_KEY_3: "key-3" }, succeedWith: "key-3" });
	assert.equal(out.available, true);
	assert.deepEqual(out.keys, ["key-1", "key-2", "key-3"]);
	assert.equal(out.results, 1);
});

test("TAVILY_API_KEY_INDEX starts at the next configured slot and wraps", async () => {
	const out = await search({ env: { TAVILY_API_KEY_1: "key-1", TAVILY_API_KEY_5: "key-5", TAVILY_API_KEY_INDEX: "2" }, succeedWith: "key-1" });
	assert.deepEqual(out.keys, ["key-5", "key-1"]);
});

test("duplicate pool and standalone keys are tried once", async () => {
	const out = await search({ env: { TAVILY_API_KEY: "dup", TAVILY_API_KEY_1: "dup", TAVILY_API_KEY_3: "dup", TAVILY_API_KEY_5: "key-5", TAVILY_API_KEY_INDEX: "3" } });
	assert.deepEqual(out.keys, ["dup", "key-5"]);
});

test("the standalone environment key is tried after the pool and logs one activity entry", async () => {
	const out = await search({ env: { TAVILY_API_KEY: "solo", TAVILY_API_KEY_1: "key-1", TAVILY_API_KEY_5: "key-5", TAVILY_API_KEY_INDEX: "5" }, succeedWith: "solo" });
	assert.deepEqual(out.keys, ["key-5", "key-1", "solo"]);
	assert.deepEqual(out.activity.map(entry => entry.status), [200]);
});

test("the configured key is tried after the pool", async () => {
	const out = await search({ config: { tavilyApiKey: "config-key" }, env: { TAVILY_API_KEY_1: "key-1" }, succeedWith: "config-key" });
	assert.deepEqual(out.keys, ["key-1", "config-key"]);
});

test("an unresolvable explicit credential source fails closed after the pool", async () => {
	const out = await search({ config: { tavilyApiKey: "$PI_WEB_ACCESS_TEST_MISSING_TAVILY_KEY" }, env: { TAVILY_API_KEY: "solo", TAVILY_API_KEY_1: "key-1" } });
	assert.deepEqual(out.keys, ["key-1"]);
	assert.equal(out.error, "Tavily credential resolution failed: environment-empty");
});

test("non-quota failures do not consume more pool keys", async () => {
	const out = await search({ env: { TAVILY_API_KEY_1: "key-1", TAVILY_API_KEY_2: "key-2" }, failStatus: 400 });
	assert.deepEqual(out.keys, ["key-1"]);
	assert.match(out.error, /Tavily API error 400/);
});
