import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const sources = {
	"http://93.184.216.34/a": "SOURCE_A " + "p".repeat(190),
	"http://93.184.216.34/b": "SOURCE_B " + "q".repeat(190),
};
const usage = (n) => ({
	input: 100 * n, output: 10 * n, cacheRead: 0, cacheWrite: 0, totalTokens: 110 * n,
	cost: { input: 0.001 * n, output: 0.0005 * n, cacheRead: 0, cacheWrite: 0, total: 0.0015 * n },
});
// Each optional split is reported by one page only; B reports a zero, which the sum must keep.
const usages = { SOURCE_A: { ...usage(1), reasoning: 5 }, SOURCE_B: { ...usage(2), cacheWrite1h: 0 } };

// Each answer call reports its own usage; the URL list may name a page that fails to fetch.
function runFixture({ mode = "answer", urls = Object.keys(sources) } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-fetch-answer-usage-"));
	const agent = join(root, "agent");
	const cache = join(root, "cache");
	mkdirSync(agent);
	mkdirSync(cache);
	writeFileSync(join(agent, "web-search.json"), JSON.stringify({ workflow: "none", fetchRouting: { providers: ["http"] } }));
	try {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const sources = ${JSON.stringify(sources)};
				const usages = ${JSON.stringify(usages)};
				globalThis.fetch = async input => {
					const source = sources[String(input instanceof Request ? input.url : input)];
					if (!source) return new Response("gone", { status: 404 });
					return new Response(source, { headers: { 'content-type': 'text/plain' } });
				};
				const { default: initialize } = await import(${JSON.stringify(indexUrl)});
				const tools = [];
				initialize({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
				const model = { provider: 'fixture', id: 'model', api: 'fixture-api', input: ['text'], contextWindow: 32000 };
				const ctx = { model, scopedModels: [], modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture-key' }),
					complete: async (_model, context) => {
						const input = context.messages[0].content[0].text;
						const key = Object.keys(usages).find(k => input.includes(k));
						return { stopReason: 'stop', content: [{ type: 'text', text: 'ANSWER ' + key }], usage: usages[key] };
					},
				} };
				const result = await tools.find(t => t.name === 'fetch_content').execute('fetch', {
					urls: ${JSON.stringify(urls)}, mode: ${JSON.stringify(mode)}, ...(${JSON.stringify(mode)} === 'answer' ? { prompt: 'Fixture question?' } : {}),
				}, undefined, undefined, ctx);
				console.log(JSON.stringify({ result }));
			`,
			encoding: "utf8", timeout: 20_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEB_ACCESS_CACHE_ROOT: cache },
		});
		assert.equal(child.status, 0, child.stderr || child.error?.message);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("answer mode reports the sum of its answer calls' usage", () => {
	const { result } = runFixture();
	assert.deepEqual(result.usage, { ...usage(3), reasoning: 5, cacheWrite1h: 0 });
});

test("a single answered URL reports its call's usage", () => {
	const { result } = runFixture({ urls: ["http://93.184.216.34/b"] });
	assert.deepEqual(result.usage, usages.SOURCE_B);
});

test("a page that fails to fetch adds no usage", () => {
	const { result } = runFixture({ urls: ["http://93.184.216.34/a", "http://93.184.216.34/missing"] });
	assert.deepEqual(result.usage, usages.SOURCE_A);
});

test("readable mode makes no model call and reports no usage", () => {
	const { result } = runFixture({ mode: "readable" });
	assert.equal(result.usage, undefined);
});
