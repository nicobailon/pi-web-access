import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const url = "http://93.184.216.34/answer-continuation";
const answer = "ANSWER_PREFIX_" + "a".repeat(1800);
const shortSource = "ORIGINAL_PAGE_MARKER " + "p".repeat(180);
const longSource = "ORIGINAL_PAGE_MARKER " + "p".repeat(2400) + " SOURCE_END";

// Each registration gets its own process, agent config and cache, including renamed
// and disabled tool settings. Only fixture HTTP and model completions are allowed.
function runFixture({ source = shortSource, mode = "answer", config = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-fetch-answer-continuation-"));
	const agent = join(root, "agent");
	const cache = join(root, "cache");
	mkdirSync(agent);
	mkdirSync(cache);
	writeFileSync(join(agent, "web-search.json"), JSON.stringify({
		workflow: "none", maxInlineContentChars: 1000,
		fetchRouting: { providers: ["http"] }, ...config,
	}));
	try {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const source = ${JSON.stringify(source)};
				const answer = ${JSON.stringify(answer)};
				const url = ${JSON.stringify(url)};
				const mode = ${JSON.stringify(mode)};
				let fetchCount = 0;
				globalThis.fetch = async input => {
					const target = String(input instanceof Request ? input.url : input);
					if (target !== url) throw new Error('Unexpected fixture HTTP request: ' + target);
					fetchCount++;
					return new Response(source, { headers: { 'content-type': 'text/plain' } });
				};
				const { default: initialize } = await import(${JSON.stringify(indexUrl)});
				const tools = [];
				initialize({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
				let completionCount = 0;
				let modelInput;
				const model = { provider: 'fixture', id: 'model', api: 'fixture-api', input: ['text'], contextWindow: 32000 };
				const ctx = { model, scopedModels: [], modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture-key' }),
					complete: async (_model, context) => {
						completionCount++;
						modelInput = context.messages[0].content[0].text;
						return { stopReason: 'stop', content: [{ type: 'text', text: answer }] };
					},
				} };
				const result = await tools.find(t => t.name === 'fetch_content').execute('fetch', {
					url, mode, ...(mode === 'answer' ? { prompt: 'Fixture question?' } : {}),
				}, undefined, undefined, ctx);
				const text = result.content[0].text;
				// Parse the actual visible call rather than rebuilding its offset from metadata.
				const match = text.match(/([\\w-]+)\\(\\{ responseId: "([^"]+)", urlIndex: (\\d+), offset: (\\d+) \\}\\)/);
				const hint = match ? { name: match[1], params: { responseId: match[2], urlIndex: Number(match[3]), offset: Number(match[4]) } } : null;
				const visibleTool = hint && tools.find(t => t.name === hint.name);
				const retrieved = visibleTool ? await visibleTool.execute('visible-source-call', hint.params) : null;
				const retrievalName = ${JSON.stringify(config.toolNames?.getSearchContent ?? "get_search_content")};
				const retrieval = tools.find(t => t.name === retrievalName);
				let storedSource = null;
				if (retrieval) {
					storedSource = '';
					let offset = 0;
					do {
						const page = await retrieval.execute('stored-source', { responseId: result.details.responseId, urlIndex: 0, offset });
						if (page.details.error) throw new Error(page.details.error);
						const bodyStart = page.content[0].text.indexOf('\\n\\n') + 2;
						storedSource += page.content[0].text.slice(bodyStart, bodyStart + page.details.returnedChars);
						offset = page.details.nextOffset;
					} while (offset !== null);
				}
				console.log(JSON.stringify({ result, hint, retrieved, storedSource, fetchCount, completionCount, modelInput, registeredNames: tools.map(t => t.name) }));
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

function assertAnswer(fixture, source) {
	const { result } = fixture;
	assert.equal(result.details.error, undefined);
	assert.equal(result.details.successful, 1);
	assert.equal(fixture.fetchCount, 1);
	assert.equal(fixture.completionCount, 1);
	assert.ok(fixture.modelInput.includes(source));
	assert.equal(result.structuredContent.responseId, result.details.responseId);
	assert.equal(result.structuredContent.urls[0].content, answer);
	assert.equal(result.details.totalChars, answer.length);
	if (fixture.storedSource !== null) assert.equal(fixture.storedSource, source);
}

function assertSourceHint(fixture, source, toolName = "get_search_content") {
	const { result, hint, retrieved } = fixture;
	assertAnswer(fixture, source);
	assert.equal(result.details.truncated, true);
	assert.ok(result.content[0].text.startsWith(answer.slice(0, 1000)));
	assert.ok(hint, "truncated answer must offer a visible source call");
	assert.equal(hint.name, toolName);
	assert.equal(hint.params.responseId, result.details.responseId);
	assert.equal(hint.params.offset, 0, "answer offsets must not be used to retrieve the original source");
	assert.equal(retrieved.details.error, undefined);
	assert.equal(retrieved.details.offset, 0);
	assert.equal(retrieved.details.contentLength, source.length);
	assert.ok(retrieved.content[0].text.includes(source.slice(0, 1000)));
	assert.doesNotMatch(retrieved.content[0].text, /ANSWER_PREFIX_/);
	assert.match(result.content[0].text, /stored content is the original source, not the remaining answer/i);
	assert.doesNotMatch(result.content[0].text, /for the next slice/);
}

test("truncated answer offers source offset zero and preserves full data", () => {
	assertSourceHint(runFixture({ source: longSource }), longSource);
});

test("truncated answer uses the configured retrieval tool name", () => {
	const fixture = runFixture({ config: { toolNames: { getSearchContent: "read_source" } } });
	assertSourceHint(fixture, shortSource, "read_source");
	assert.doesNotMatch(fixture.result.content[0].text, /get_search_content/);
});

test("disabled retrieval still discloses answer truncation and original-source storage without a call", () => {
	const fixture = runFixture({ config: {
		toolNames: { getSearchContent: "read_source" }, tools: { getSearchContent: { enabled: false } },
	} });
	assertAnswer(fixture, shortSource);
	assert.equal(fixture.result.details.truncated, true);
	assert.ok(!fixture.registeredNames.includes("read_source"));
	assert.equal(fixture.hint, null);
	const text = fixture.result.content[0].text;
	assert.match(text, /stored content is the original source, not the remaining answer/i);
	assert.match(text, /Content retrieval is not registered/);
	assert.doesNotMatch(text, /read_source|get_search_content|for the next slice/);
});

test("readable fetch retains its next-slice continuation into the original source", () => {
	const fixture = runFixture({ mode: "readable", source: longSource });
	const { result, hint, retrieved } = fixture;
	assert.equal(fixture.completionCount, 0);
	assert.equal(fixture.storedSource, longSource);
	assert.equal(result.structuredContent.urls[0].content, longSource);
	assert.equal(result.details.truncated, true);
	assert.equal(result.content[0].text.split("\n\n---\n")[0], longSource.slice(0, 1000));
	assert.match(result.content[0].text, /for the next slice/);
	assert.doesNotMatch(result.content[0].text, /not the remaining answer/);
	assert.equal(hint.params.offset, 1000);
	assert.equal(retrieved.details.error, undefined);
	assert.equal(retrieved.details.offset, 1000);
	assert.ok(retrieved.content[0].text.includes(longSource.slice(1000, 2000)));
});
