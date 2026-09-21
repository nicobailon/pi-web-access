import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const DEFAULT_CAP = 30_000;
const LARGE_ANSWER_LENGTH = 116_000;

function runBoundaryScenario(config = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-access-output-boundary-"));
	try {
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider: "openai", ...config }));
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
			const answer = "A".repeat(${LARGE_ANSWER_LENGTH} - 11) + "LATE_ANSWER";
			let requestCount = 0;
			globalThis.fetch = async (url) => {
				if (String(url) !== "https://api.openai.com/v1/responses") throw new Error("Unexpected fetch: " + url);
				requestCount++;
				return new Response(JSON.stringify({ output: [
					{ type: "web_search_call", action: { sources: [{ title: "Source " + requestCount, url: "https://example.com/source-" + requestCount }] } },
					{ type: "message", content: [{ type: "output_text", text: answer }] },
				] }), { status: 200, headers: { "content-type": "application/json" } });
			};
			const tools = [];
			const handlers = new Map();
			const entries = [];
			const pi = {
				registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {},
				on(event, handler) { handlers.set(event, handler); },
				appendEntry(type, data) { if (data.type === "search") entries.push(data); }, sendMessage() {},
			};
			const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
			initializeExtension(pi);
			await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
			const search = tools.find(tool => tool.name === "web_search");
			const result = await search.execute("call", { queries: ["first", "second"] });
			const retrieve = tools.find(tool => tool.name === "get_search_content");
			const pageLimit = retrieve?.parameters.properties.limit.maximum;
			const page1 = retrieve ? await retrieve.execute("page-1", { responseId: result.details.searchId, queryIndex: 0, limit: pageLimit }) : null;
			const page2 = retrieve ? await retrieve.execute("page-2", { responseId: result.details.searchId, queryIndex: 0, offset: page1.details.nextOffset, limit: pageLimit }) : null;
			const found = retrieve ? await retrieve.execute("find", { responseId: result.details.searchId, queryIndex: 0, findText: "LATE_ANSWER", findMode: "exact" }) : null;
			console.log(JSON.stringify({
				text: result.content[0].text, details: result.details, requestCount,
				storedAnswers: entries.at(-1)?.queries.map(query => query.answer.length),
				storedLate: entries.at(-1)?.queries.every(query => query.answer.endsWith("LATE_ANSWER")),
				page1: page1 && { details: page1.details, text: page1.content[0].text },
				page2: page2 && { details: page2.details, text: page2.content[0].text },
				found: found && { details: found.details, text: found.content[0].text },
			}));
			`,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "boundary-test-key" },
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let cachedDefaultScenario;
function defaultBoundaryScenario() {
	return cachedDefaultScenario ??= runBoundaryScenario();
}

function runIncludeContentScenario(mode) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-access-output-guidance-"));
	const provider = mode === "inline" ? "anysearch" : "openai";
	try {
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider, maxInlineContentChars: 1_000 }));
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
			const answer = "A".repeat(${LARGE_ANSWER_LENGTH});
			globalThis.fetch = async (url) => {
				const target = String(url);
				if (${JSON.stringify(mode)} === "inline" && target === "https://api.anysearch.com/v1/search") {
					return new Response(JSON.stringify({ code: 0, data: { results: [{ title: "Inline", url: "https://example.com/inline", snippet: answer, content: "full inline page" }], metadata: {} } }), { status: 200 });
				}
				if (${JSON.stringify(mode)} === "background" && target === "https://api.openai.com/v1/responses") {
					return new Response(JSON.stringify({ output: [
						{ type: "web_search_call", action: { sources: [{ title: "Background", url: "https://example.com/background" }] } },
						{ type: "message", content: [{ type: "output_text", text: answer }] },
					] }), { status: 200, headers: { "content-type": "application/json" } });
				}
				if (target === "https://example.com/background") return new Response("<main>background page</main>", { headers: { "content-type": "text/html" } });
				throw new Error("Unexpected fetch: " + target);
			};
			const tools = [];
			const handlers = new Map();
			const pi = { registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on(event, handler) { handlers.set(event, handler); }, appendEntry() {}, sendMessage() {} };
			const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
			initializeExtension(pi);
			await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
			const result = await tools.find(tool => tool.name === "web_search").execute("call", { query: "content guidance", includeContent: true });
			console.log(JSON.stringify({ text: result.content[0].text, details: result.details }));
			`,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "boundary-test-key" },
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("default raw multi-query output is bounded, attributed, and stored without mutation", () => {
	const out = defaultBoundaryScenario();
	assert.equal(out.requestCount, 2);
	assert.equal(out.text.length, DEFAULT_CAP);
	assert.match(out.text, /Output truncated/);
	assert.match(out.text, /responseId "[a-z0-9]+"/);
	assert.match(out.text, /get_search_content\(\{ responseId: "[a-z0-9]+", queryIndex: 0, offset: 0, limit: 30000 \}\)/);
	assert.match(out.text, /Providers used:\*\* Query 1: openai; Query 2: openai/);
	assert.deepEqual(out.details.queryProviders, [
		{ query: "first", providers: ["openai"] },
		{ query: "second", providers: ["openai"] },
	]);
	assert.equal(out.details.truncated, true);
	const truncationLabel = "\n\n---\n[Output truncated.]";
	const retainedPrefix = out.text.indexOf(truncationLabel);
	assert.ok(retainedPrefix > 0);
	assert.equal(out.details.returnedChars, retainedPrefix);
	const retainedGuidance = out.text.slice(retainedPrefix + truncationLabel.length);
	assert.ok(retainedGuidance.length > 0);
	assert.equal(out.details.originalChars - out.details.returnedChars, out.details.omittedChars);
	assert.deepEqual(out.storedAnswers, [LARGE_ANSWER_LENGTH, LARGE_ANSWER_LENGTH]);
	assert.equal(out.storedLate, true);
});

test("stored search answers support bounded continuation and findText", () => {
	const out = defaultBoundaryScenario();
	assert.equal(out.page1.details.offset, 0);
	assert.ok(out.page1.details.returnedChars < DEFAULT_CAP);
	assert.equal(out.page1.details.nextOffset, out.page1.details.returnedChars);
	assert.ok(out.page1.text.length <= DEFAULT_CAP);
	assert.equal(out.page1.details.truncated, true);
	assert.equal(out.page2.details.offset, out.page1.details.nextOffset);
	assert.ok(out.page2.details.returnedChars < DEFAULT_CAP);
	assert.equal(out.page2.details.nextOffset, out.page2.details.offset + out.page2.details.returnedChars);
	assert.ok(out.page2.text.length <= DEFAULT_CAP);
	assert.equal(out.page1.details.contentLength, out.page2.details.contentLength);
	assert.doesNotMatch(out.page1.text, /LATE_ANSWER/);
	assert.match(out.found.text, /LATE_ANSWER/);
	assert.equal(out.found.details.contentLength, out.page1.details.contentLength);
});

test("truncated output discloses disabled retrieval while remaining within the cap", () => {
	const out = runBoundaryScenario({ tools: { getSearchContent: { enabled: false } } });
	assert.equal(out.text.length, DEFAULT_CAP);
	assert.match(out.text, /Output truncated/);
	assert.match(out.text, /responseId "[a-z0-9]+"/);
	assert.match(out.text, /Enable get_search_content to retrieve the full stored results/);
	assert.equal(out.page1, null);
});

test("configured inline limit bounds the complete raw presentation", () => {
	const configuredCap = 12_000;
	const out = runBoundaryScenario({ maxInlineContentChars: configuredCap });
	assert.equal(out.text.length, configuredCap);
	assert.ok(out.details.returnedChars < configuredCap);
	assert.match(out.text, /limit: 12000/);
	assert.ok(out.page1.details.returnedChars < configuredCap);
});

test("below-minimum inline limit falls back to the default and exact minimum remains complete", () => {
	const belowMinimum = runBoundaryScenario({ maxInlineContentChars: 999 });
	assert.equal(belowMinimum.text.length, DEFAULT_CAP);
	assert.match(belowMinimum.text, /limit: 30000/);
	const exactMinimum = runBoundaryScenario({ maxInlineContentChars: 1_000 });
	assert.equal(exactMinimum.text.length, 1_000);
	assert.match(exactMinimum.text, /Output truncated/);
	assert.match(exactMinimum.text, /responseId "[a-z0-9]+"/);
	assert.match(exactMinimum.text, /limit: 1000/);
});

test("truncated inline-ready search retains fetch and search retrieval guidance", () => {
	const out = runIncludeContentScenario("inline");
	assert.equal(out.text.length, 1_000);
	assert.ok(out.details.originalChars < LARGE_ANSWER_LENGTH + 1_000, "raw sources must not duplicate the snippet-derived provider answer");
	assert.match(out.text, new RegExp(`Full content for 1 sources is ready as responseId "${out.details.fetchId}"`));
	assert.match(out.text, new RegExp(`get_search_content\\(\\{ responseId: "${out.details.fetchId}", urlIndex: 0, offset: 0, limit: 1000 \\}\\)`));
	assert.match(out.text, new RegExp(`Full search results are stored as responseId "${out.details.searchId}"`));
	assert.match(out.text, new RegExp(`get_search_content\\(\\{ responseId: "${out.details.searchId}", queryIndex: 0, offset: 0, limit: 1000 \\}\\)`));
});

test("truncated background-fetch search retains state, fetchId, and search retrieval guidance", () => {
	const out = runIncludeContentScenario("background");
	assert.equal(out.text.length, 1_000);
	assert.match(out.text, new RegExp(`Content fetching in background as responseId "${out.details.fetchId}"`));
	assert.match(out.text, /Will notify when ready/);
	assert.match(out.text, new RegExp(`Full search results are stored as responseId "${out.details.searchId}"`));
	assert.match(out.text, new RegExp(`get_search_content\\(\\{ responseId: "${out.details.searchId}", queryIndex: 0, offset: 0, limit: 1000 \\}\\)`));
});
