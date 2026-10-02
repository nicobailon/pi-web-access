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
const PROVIDED_URL = "https://example.com/provided";
const fetchMock = `
const articleHtml = "<html><head><title>Standalone Article</title></head><body><article><h1>Standalone Article</h1>"
	+ "<p>" + "The standalone web tool core fetched this readable paragraph without the Pi runtime. ".repeat(12) + "</p>"
	+ "</article></body></html>";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const requests = [];
globalThis.fetch = async (input) => {
	const url = String(input instanceof Request ? input.url : input);
	requests.push(url);
	if (url === "https://api.anysearch.com/v1/search") {
		return Response.json({ code: 0, data: { results: [
			{ title: "Standalone Article", url: ${JSON.stringify(ARTICLE_URL)}, snippet: "no body" },
			{ title: "Provided", url: ${JSON.stringify(PROVIDED_URL)}, snippet: "has body", content: "provider page body" },
		], metadata: {} } });
	}
	if (url.startsWith("https://api.search.brave.com/") && url.includes("brave-fails")) return new Response("provider failed", { status: 401 });
	if (url.startsWith("https://api.search.brave.com/") && url.includes("brave-empty")) return Response.json({ web: { results: [] } });
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

test("standalone auto search skips Pi-only routes and only calls where nothing succeeded are errors", () => {
	const { out, blocked } = runStandalone(`
		const core = createStandaloneWebToolCore();
		return {
			auto: await core.webSearch({ query: "standalone core" }),
			failed: await core.webSearch({ query: "brave-fails", provider: "brave" }),
			mixed: await core.webSearch({ queries: ["standalone core", "brave-fails"], provider: "brave" }),
			failedFetch: await core.fetchContent({ urls: ["http://93.184.216.34/missing-a", "http://93.184.216.34/missing-b"] }),
			failedCheck: await core.sourceCheck({ claim: "brave-fails", provider: "brave" }),
			partialCheck: await core.sourceCheck({ claim: "brave-empty", queries: ["brave-empty", "brave-fails"], provider: "brave" }),
		};
	`, { config: { searchRouting: { providers: ["openai", "brave"], useCurrentModel: true, fallbackOn: ["transient"] } } });
	assert.deepEqual(blocked, []);
	// auto skips the current-model OpenAI route, which needs Pi, and uses Brave.
	assert.equal(out.auto.isError, undefined);
	assert.deepEqual(out.auto.details.queryProviders, [{ query: "standalone core", providers: ["brave"] }]);
	assert.equal(out.failed.isError, true);
	assert.match(out.failed.content[0].text, /Brave Search API error 401/);
	assert.equal(out.mixed.isError, undefined);
	assert.equal(out.mixed.details.successfulQueries, 1);
	assert.equal(out.failedFetch.isError, true);
	assert.equal(out.failedFetch.details.successful, 0);
	assert.equal(out.failedCheck.isError, true);
	assert.equal(out.partialCheck.isError, undefined);
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

test("standalone includeContent keeps provider page content and fetches only uncovered URLs", () => {
	const { out, requests } = runStandalone(`
		const core = createStandaloneWebToolCore();
		const result = await core.webSearch({ query: "partial content", provider: "anysearch", includeContent: true });
		const pages = [];
		for (const urlIndex of [0, 1]) pages.push((await core.getSearchContent({ responseId: result.details.fetchId, urlIndex })).content[0].text);
		return { text: result.content[0].text, details: result.details, pages };
	`);
	assert.deepEqual(requests, ["https://api.anysearch.com/v1/search", ARTICLE_URL]);
	assert.match(out.text, new RegExp(`Full content for 2 sources is ready as responseId "${out.details.fetchId}"`));
	assert.match(out.pages[0], /readable paragraph without the Pi runtime/);
	assert.match(out.pages[1], /^# Provided\n\nprovider page body/);
});

test("standalone rejects Pi-only providers and fetch modes before any network call", () => {
	const { out, requests } = runStandalone(`
		const core = createStandaloneWebToolCore();
		return {
			kimiSourceCheck: await core.sourceCheck({ claim: "c", provider: ["brave", "kimi"] }),
			answer: await core.fetchContent({ url: ${JSON.stringify(ARTICLE_URL)}, mode: "answer" }),
			defaultAnswer: await core.fetchContent({ url: ${JSON.stringify(ARTICLE_URL)} }),
		};
	`, { config: { fetch: { defaultMode: "answer" } } });
	assert.deepEqual(requests, []);
	for (const result of Object.values(out)) assert.equal(result.isError, true);
	assert.match(out.kimiSourceCheck.content[0].text, /Kimi search is not supported over MCP/);
	assert.match(out.answer.content[0].text, /mode "answer" is not supported over MCP/);
	assert.match(out.defaultAnswer.content[0].text, /fetch\.defaultMode .* is "answer", which is not supported over MCP/);
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
		const core = createStandaloneWebToolCore();
		const ids = [];
		for (let i = 0; i < 51; i++) ids.push((await core.fetchContent({ url: ${JSON.stringify(ARTICLE_URL)} })).details.responseId);
		const oldest = await core.getSearchContent({ responseId: ids[0] });
		const kept = await core.getSearchContent({ responseId: ids[1] });
		return { oldest, kept };
	`);
	assert.equal(out.oldest.isError, true);
	assert.match(out.oldest.content[0].text, /No stored results for responseId/);
	assert.equal(out.kept.isError, undefined);
	assert.match(out.kept.content[0].text, /readable paragraph without the Pi runtime/);
});
