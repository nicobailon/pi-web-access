import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

async function run(routing, body, extra = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-weak-routing-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({ searchRouting: routing }) + "\n", "utf8");
	const env = { ...process.env, PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "brave-test-key", TAVILY_API_KEY: "tavily-test-key", ...extra };
	for (const key of ["XDG_CONFIG_HOME", "EXA_API_KEY", "PARALLEL_API_KEY", "OPENAI_API_KEY"]) delete env[key];
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			const brave = (results) => new Response(JSON.stringify({ web: { results } }), { status: 200 });
			const tavily = (results, answer = "") => new Response(JSON.stringify({ answer, results }), { status: 200 });
			${body}
		`,
		encoding: "utf8",
		env,
		timeout: 30_000,
	});
}

const base = ["transient", "quota", "network", "invalid-response", "unsupported"];

test("an empty success moves to the next provider only when fallbackOn includes empty", async () => {
	const script = `
		globalThis.fetch = async (url) => {
			calls.push(String(url).includes("brave") ? "brave" : "tavily");
			return String(url).includes("brave")
				? brave([])
				: tavily([{ title: "T", url: "https://example.com/a", content: "text" }]);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("q", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`;
	const opted = await run({ providers: ["brave", "tavily"], fallbackOn: [...base, "empty"] }, script);
	assert.equal(opted.status, 0, opted.stderr);
	assert.deepEqual(JSON.parse(opted.stdout.trim()), { provider: "tavily", calls: ["brave", "tavily"] });

	const unchanged = await run({ providers: ["brave", "tavily"], fallbackOn: base }, script);
	assert.equal(unchanged.status, 0, unchanged.stderr);
	assert.deepEqual(JSON.parse(unchanged.stdout.trim()), { provider: "brave", calls: ["brave"] });
});

test("domain-miss moves on when no result matches a requested domain, and ignores excludes", async () => {
	const script = `
		globalThis.fetch = async (url) => {
			calls.push(String(url).includes("brave") ? "brave" : "tavily");
			return String(url).includes("brave")
				? brave([{ title: "Other", url: "https://other.example.org/x", description: "d" }])
				: tavily([{ title: "Docs", url: "https://docs.example.com/y", content: "text" }]);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const hit = await search("q", { provider: "auto", domainFilter: ["example.com"] });
		const exclude = await search("q", { provider: "auto", domainFilter: ["-spam.test"] });
		console.log(JSON.stringify({ hit: hit.provider, exclude: exclude.provider, calls }));
	`;
	const child = await run({ providers: ["brave", "tavily"], fallbackOn: [...base, "domain-miss"] }, script);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { hit: "tavily", exclude: "brave", calls: ["brave", "tavily", "brave"] });
});

test("when every candidate is weak the first weak response is returned", async () => {
	const child = await run({ providers: ["brave", "tavily"], fallbackOn: [...base, "empty"] }, `
		globalThis.fetch = async (url) => {
			calls.push(String(url).includes("brave") ? "brave" : "tavily");
			return String(url).includes("brave") ? brave([]) : tavily([]);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("q", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, results: result.results.length, calls }));
	`);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { provider: "brave", results: 0, calls: ["brave", "tavily"] });
});

test("a named provider stays strict even when routing opts into empty", async () => {
	const child = await run({ providers: ["brave", "tavily"], fallbackOn: [...base, "empty"] }, `
		globalThis.fetch = async (url) => { calls.push(String(url).includes("brave") ? "brave" : "tavily"); return brave([]); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("q", { provider: "brave" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { provider: "brave", calls: ["brave"] });
});

test("timeoutMs bounds the whole route and stops trying later candidates", async () => {
	const child = await run({ providers: ["brave", "tavily"], fallbackOn: [...base, "empty"], timeoutMs: 300 }, `
		globalThis.fetch = (url, init) => new Promise((_, reject) => {
			calls.push(String(url).includes("brave") ? "brave" : "tavily");
			init?.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
		});
		const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers are unref'd
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const started = Date.now();
		try { await search("q", { provider: "auto" }); console.log("unexpected success"); }
		catch (err) { console.log(JSON.stringify({ message: String(err.message), calls, fast: Date.now() - started < 5000 })); }
		clearInterval(keepAlive);
	`);
	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout.trim());
	assert.match(out.message, /Configured search routing exhausted/);
	assert.match(out.message, /routing timeout after 300ms/);
	assert.deepEqual(out.calls, ["brave"]);
	assert.equal(out.fast, true);
});

test("timeoutMs also bounds a candidate's slow availability and auth work", async () => {
	const child = await run({ providers: ["openai", "brave"], fallbackOn: base, timeoutMs: 200 }, `
		globalThis.fetch = (url, init) => new Promise((_, reject) => {
			calls.push(String(url));
			init?.signal?.addEventListener("abort", () => reject(init.signal.reason));
		});
		const extensionContext = { model: undefined, modelRegistry: {
			getAll: () => [{ id: "gpt-5.5", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }],
			getApiKeyAndHeaders: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, apiKey: "tok" }), 1500)),
		} };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const started = Date.now();
		try { await search("q", { provider: "auto", extensionContext }); console.log("unexpected success"); }
		catch (err) { console.log(JSON.stringify({ message: String(err.message), calls, elapsed: Date.now() - started })); }
	`);
	assert.equal(child.status, 0, child.stderr);
	const out = JSON.parse(child.stdout.trim());
	assert.match(out.message, /openai: routing timeout after 200ms/);
	assert.deepEqual(out.calls, []);
	assert.ok(out.elapsed < 500, `routed search took ${out.elapsed}ms`);
});

test("invalid timeoutMs and fallbackOn kinds are rejected", async () => {
	for (const [routing, field] of [
		[{ providers: ["brave"], fallbackOn: base, timeoutMs: 0 }, "timeoutMs"],
		[{ providers: ["brave"], fallbackOn: base, timeoutMs: "soon" }, "timeoutMs"],
		[{ providers: ["brave"], fallbackOn: ["weak"] }, "fallbackOn"],
	]) {
		const child = await run(routing, `
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			try { await search("q", { provider: "auto" }); } catch (err) { console.log(String(err.message)); }
		`);
		assert.match(child.stdout, new RegExp(`searchRouting\\.${field}`), child.stderr);
	}
});
