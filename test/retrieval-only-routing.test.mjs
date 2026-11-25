import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const rewriteModuleUrl = new URL("../query-rewrite.ts", import.meta.url).href;
const ON = { PI_WEB_ACCESS_RETRIEVAL_ONLY: "1" };

async function run(config, body, extra = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-retrieval-only-routing-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const env = { ...process.env, PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "brave-test-key", ...extra };
	for (const key of ["XDG_CONFIG_HOME", "EXA_API_KEY", "PARALLEL_API_KEY", "OPENAI_API_KEY"]) delete env[key];
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: `const calls = [];\n${body}`, encoding: "utf8", env, timeout: 30_000 });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("the off-topic judge never runs under the policy and the response is kept", async () => {
	const config = { searchRouting: { providers: ["brave", "tavily"], fallbackOn: ["transient", "off-topic"], offTopicModel: "cloudflare-workers-ai/@cf/cloudflare/clef" } };
	const body = `
		const modelRegistry = { findOfType: () => ({ id: "clef" }), async classify() {
			calls.push("judge");
			return { stopReason: "stop", answers: { relevance: { type: "choice", choice: "addresses", probabilities: { addresses: 0.9, off_topic: 0.1 }, confidence: 0.9 } } };
		} };
		globalThis.fetch = async (url) => {
			calls.push(String(url).includes("brave") ? "brave" : "other");
			return new Response(JSON.stringify({ web: { results: [{ title: "B", url: "https://example.com/b", description: "d" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("q", { provider: "auto", extensionContext: { modelRegistry } });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`;
	assert.deepEqual(await run(config, body), { provider: "brave", calls: ["brave", "judge"] });
	assert.deepEqual(await run(config, body, ON), { provider: "brave", calls: ["brave"] });
});

test("query rewrite refuses under the policy without touching the model registry", async () => {
	const out = await run({}, `
		const model = { api: "custom-rewrite-api", provider: "anthropic", id: "claude-haiku-4-5", input: ["text"] };
		const modelRegistry = {
			find: () => { calls.push("find"); return model; },
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => { calls.push("auth"); return { ok: true, apiKey: "k" }; },
			complete: async () => { calls.push("complete"); return { stopReason: "stop", content: [{ type: "text", text: "rewritten" }] }; },
		};
		const { rewriteSearchQuery } = await import(${JSON.stringify(rewriteModuleUrl)});
		let error;
		try { await rewriteSearchQuery("q", { modelRegistry, scopedModels: [] }, new AbortController().signal); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, calls }));
	`, ON);
	assert.match(out.error, /Query rewrite is blocked by the retrieval-only policy \(PI_WEB_ACCESS_RETRIEVAL_ONLY=1\)/);
	assert.deepEqual(out.calls, []);
});
