import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;

// Every child runs with @earendil-works/* unresolvable, proving the standalone
// core never needs the Pi runtime, and logs every module it loads.
const hookSource = `
import { appendFileSync } from "node:fs";
let logPath;
export function initialize(data) { logPath = data.logPath; }
export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith("@earendil-works/")) {
		appendFileSync(logPath, "BLOCKED " + specifier + "\\n");
		throw new Error("Pi runtime import blocked: " + specifier);
	}
	const resolved = await nextResolve(specifier, context);
	appendFileSync(logPath, "LOADED " + resolved.url + "\\n");
	return resolved;
}
`;

const ARTICLE_URL = "http://93.184.216.34/article";
const IMAGE_URL = "http://93.184.216.34/pixel.png";
const fetchMock = `
const articleHtml = "<html><head><title>Standalone Article</title></head><body><article><h1>Standalone Article</h1>"
	+ "<p>" + "The standalone web tool core fetched this readable paragraph without the Pi runtime. ".repeat(12) + "</p>"
	+ "</article></body></html>";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const requests = [];
globalThis.fetch = async (input) => {
	const url = String(input instanceof Request ? input.url : input);
	requests.push(url);
	if (url.startsWith("https://api.search.brave.com/")) {
		return Response.json({ web: { results: [{ title: "Standalone Article", url: ${JSON.stringify(ARTICLE_URL)}, description: "Brave snippet" }] } });
	}
	if (url === ${JSON.stringify(ARTICLE_URL)}) return new Response(articleHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
	if (url === ${JSON.stringify(IMAGE_URL)}) return new Response(png, { headers: { "content-type": "image/png" } });
	throw new Error("Unexpected fetch: " + url);
};
`;

function runStandalone(body, { config = {}, env = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-access-core-"));
	try {
		writeFileSync(join(dir, "web-search.json"), JSON.stringify(config));
		const logPath = join(dir, "modules.log");
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				import { register } from "node:module";
				register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hookSource)}), {
					parentURL: import.meta.url,
					data: { logPath: ${JSON.stringify(logPath)} },
				});
				const { createStandaloneWebToolCore } = await import(${JSON.stringify(coreUrl)});
				${fetchMock}
				const out = await (async () => { ${body} })();
				console.log(JSON.stringify({ out, requests }));
			`,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, BRAVE_API_KEY: "core-test-key", ...env },
		});
		assert.equal(child.status, 0, child.stderr);
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : [];
		const { out, requests } = JSON.parse(child.stdout.trim().split("\n").at(-1));
		return {
			out,
			requests,
			blocked: log.filter(line => line.startsWith("BLOCKED ")),
			loaded: log.filter(line => line.startsWith("LOADED ")).map(line => line.slice("LOADED ".length)),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("standalone web_search returns provider results retrievable by responseId", () => {
	const { out, blocked } = runStandalone(`
		const core = createStandaloneWebToolCore();
		const result = await core.webSearch({ query: "standalone core", provider: "brave" });
		const searchId = result.content[0].text.match(/stored as responseId "([^"]+)"/)[1];
		const retrieved = await core.getSearchContent({ responseId: searchId, queryIndex: 0 });
		return { text: result.content[0].text, isError: result.isError ?? false, searchId, details: result.details, retrieved };
	`);
	assert.deepEqual(blocked, []);
	assert.equal(out.isError, false);
	assert.match(out.text, /\*\*Provider:\*\* brave/);
	assert.match(out.text, /Standalone Article\n {3}http:\/\/93\.184\.216\.34\/article/);
	assert.match(out.text, /Use get_search_content\(\{ responseId: "[^"]+", queryIndex: 0/);
	assert.equal(out.details.searchId, out.searchId);
	assert.equal(out.retrieved.isError, undefined);
	assert.match(out.retrieved.content[0].text, /### Standalone Article\nhttp:\/\/93\.184\.216\.34\/article\n\nBrave snippet/);
});

test("standalone includeContent waits for page content before returning", () => {
	const { out, blocked } = runStandalone(`
		const core = createStandaloneWebToolCore();
		const result = await core.webSearch({ query: "standalone core", provider: "brave", includeContent: true });
		const fetchId = result.details.fetchId;
		const page = await core.getSearchContent({ responseId: fetchId, urlIndex: 0 });
		return { text: result.content[0].text, details: result.details, page: page.content[0].text };
	`);
	assert.deepEqual(blocked, []);
	assert.match(out.text, new RegExp(`Full content for 1 sources is ready as responseId "${out.details.fetchId}"`));
	assert.doesNotMatch(out.text, /in background|Will notify/);
	assert.equal(out.details.fetchUrls, undefined);
	assert.match(out.page, /readable paragraph without the Pi runtime/);
});

test("standalone fetch_content returns readable markdown", () => {
	const { out, blocked } = runStandalone(`
		const core = createStandaloneWebToolCore();
		return core.fetchContent({ url: ${JSON.stringify(ARTICLE_URL)} });
	`);
	assert.deepEqual(blocked, []);
	assert.equal(out.isError, undefined);
	assert.equal(out.details.title, "Standalone Article");
	assert.ok(out.details.responseId);
	assert.match(out.content.at(-1).text, /readable paragraph without the Pi runtime/);
	assert.doesNotMatch(out.content.at(-1).text, /<p>|<article>/);
});

test("standalone rejects Pi-only providers and fetch modes before any network call", () => {
	const { out, requests } = runStandalone(`
		const core = createStandaloneWebToolCore();
		return {
			kimi: await core.webSearch({ query: "q", provider: "kimi" }),
			kimiSourceCheck: await core.sourceCheck({ claim: "c", provider: ["brave", "kimi"] }),
			answer: await core.fetchContent({ url: ${JSON.stringify(ARTICLE_URL)}, mode: "answer" }),
			prompt: await core.fetchContent({ url: ${JSON.stringify(ARTICLE_URL)}, prompt: "summarize" }),
		};
	`);
	assert.deepEqual(requests, []);
	for (const result of Object.values(out)) assert.equal(result.isError, true);
	assert.match(out.kimi.content[0].text, /Kimi search is not supported over MCP/);
	assert.match(out.kimiSourceCheck.content[0].text, /Kimi search is not supported over MCP/);
	assert.match(out.answer.content[0].text, /mode "answer" is not supported over MCP/);
	assert.match(out.prompt.content[0].text, /prompt is not supported over MCP/);
});

test("standalone direct image fetch fails clearly without loading Pi or Pi-only modules", () => {
	const { out, blocked, loaded } = runStandalone(`
		const core = createStandaloneWebToolCore();
		return core.fetchContent({ url: ${JSON.stringify(IMAGE_URL)} });
	`);
	assert.deepEqual(blocked, []);
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /Direct image fetch is not supported over MCP/);
	assert.ok(loaded.some(url => url.endsWith("/extract.ts")), "the image request went through extraction");
	const piOnly = loaded.filter(url => /\/(index|tool-activation|curator-[a-z]+|summary-review|summary-model-scope|page-query|query-rewrite)\.ts$/.test(url));
	assert.deepEqual(piOnly, []);
});

test("standalone store evicts the oldest stored result past its bound", () => {
	const { out } = runStandalone(`
		const core = createStandaloneWebToolCore({ maxStoredResults: 2 });
		const ids = [];
		for (let i = 0; i < 3; i++) ids.push((await core.fetchContent({ url: ${JSON.stringify(ARTICLE_URL)} })).details.responseId);
		const oldest = await core.getSearchContent({ responseId: ids[0] });
		const newest = await core.getSearchContent({ responseId: ids[2] });
		return { oldest, newest };
	`);
	assert.equal(out.oldest.isError, true);
	assert.match(out.oldest.content[0].text, /No stored results for responseId/);
	assert.equal(out.newest.isError, undefined);
	assert.match(out.newest.content[0].text, /readable paragraph without the Pi runtime/);
});
