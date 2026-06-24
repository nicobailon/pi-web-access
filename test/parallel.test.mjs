import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const parallelModuleUrl = new URL("../parallel.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-parallel-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Parallel availability reads env and config keys while rejecting placeholders", async () => {
	const home = await createHome({ parallelApiKey: "your-key" });
	let child = runChild(`
		const { isParallelAvailable } = await import(${JSON.stringify(parallelModuleUrl)});
		console.log(String(isParallelAvailable()));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	child = runChild(`
		const { isParallelAvailable } = await import(${JSON.stringify(parallelModuleUrl)});
		console.log(String(isParallelAvailable()));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const configHome = await createHome({ parallelApiKey: "pk_live_parallel_config_key" });
	child = runChild(`
		const { isParallelAvailable } = await import(${JSON.stringify(parallelModuleUrl)});
		console.log(String(isParallelAvailable()));
	`, { HOME: configHome, USERPROFILE: configHome, PARALLEL_API_KEY: "" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("explicit Parallel search routes through Parallel API and maps results", async () => {
	const home = await createHome({ provider: "parallel" });
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				results: [{ title: "Parallel Docs", url: "https://docs.parallel.ai/search", excerpts: ["Parallel search excerpt"] }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("parallel search docs", { provider: "parallel", includeContent: true, numResults: 3, domainFilter: ["docs.parallel.ai", "-example.com"] });
		console.log(JSON.stringify({ captured, result }));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://api.parallel.ai/v1/search");
	assert.equal(output.captured.headers["x-api-key"], "pk_live_parallel_test_key");
	assert.deepEqual(output.captured.body.advanced_settings, {
		max_results: 3,
		source_policy: { include_domains: ["docs.parallel.ai"], exclude_domains: ["example.com"] },
	});
	assert.equal(output.result.provider, "parallel");
	assert.deepEqual(output.result.results, [{ title: "Parallel Docs", url: "https://docs.parallel.ai/search", snippet: "Parallel search excerpt" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://docs.parallel.ai/search", title: "Parallel Docs", content: "Parallel search excerpt", error: null }]);
});

test("Parallel extract retries full content when excerpts are too short", async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(init.body) });
			if (calls.length === 1) {
				return new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Short", excerpts: ["too short"] }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Full", full_content: "# Full\\n" + "x".repeat(600) }] }), { status: 200 });
		};
		const { extractWithParallel } = await import(${JSON.stringify(parallelModuleUrl)});
		const result = await extractWithParallel("https://example.com");
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	assert.deepEqual(output.calls[1].body.advanced_settings, { full_content: true });
	assert.equal(output.result.title, "Full");
	assert.equal(output.result.error, null);
	assert.match(output.result.content, /^# Full/);
});

test("fetch_content continues to Gemini when Parallel extract fails", async () => {
	const home = await createHome({ geminiApiKey: "gemini-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.com/app") {
				return new Response("<html><body><script></script><script></script><script></script><script></script>Loading</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("", { status: 503 });
			}
			if (urlText === "https://api.parallel.ai/v1/extract") {
				return new Response("parallel exploded", { status: 500 });
			}
			if (urlText.includes("generativelanguage.googleapis.com")) {
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Gemini fallback\\n" + "Recovered content ".repeat(20) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/app");
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.includes("https://api.parallel.ai/v1/extract"));
	assert.ok(output.calls.some((url) => url.includes("generativelanguage.googleapis.com")));
	assert.equal(output.result.error, null);
	assert.match(output.result.content, /Gemini fallback/);
});
