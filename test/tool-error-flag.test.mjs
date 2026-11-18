import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const { BRAVE_BASE_URL: _braveBaseUrl, ...baseEnv } = process.env;

// Only the network is mocked: Brave answers per query text ("fail" -> HTTP 401,
// "empty" -> no results, anything else -> one result); any other URL fails.
const fetchMock = `
const requests = [];
globalThis.fetch = async (input) => {
	const url = String(input instanceof Request ? input.url : input);
	requests.push(url);
	if (!url.startsWith("https://api.search.brave.com/")) throw new Error("Unexpected fetch: " + url);
	const query = new URL(url).searchParams.get("q") ?? "";
	if (query.includes("fail")) return new Response("forced provider failure", { status: 401 });
	if (query.includes("empty")) return Response.json({ web: { results: [] } });
	return Response.json({ web: { results: [{ title: "Example", url: "https://example.com/" + encodeURIComponent(query), description: "Example snippet" }] } });
};
`;

// Runs one registered Pi tool's execute with the given params in an isolated
// Pi config dir and returns its result plus the mocked requests.
async function runTool(toolName, params) {
	const home = await mkdtemp(join(tmpdir(), "pi-tool-error-flag-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify({ workflow: "none" }));
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				${fetchMock}
				const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
				const tools = [];
				initializeExtension({
					registerTool(tool) { tools.push(tool); },
					registerCommand() {},
					registerShortcut() {},
					on() {},
					appendEntry() {},
					sendMessage() {},
					exec() { return { code: 0 }; },
				});
				const tool = tools.find((tool) => tool.name === ${JSON.stringify(toolName)});
				const result = await tool.execute("call", ${JSON.stringify(params)});
				console.log(JSON.stringify({ result, requests }));
			`,
			encoding: "utf8",
			timeout: 30_000,
			env: { ...baseEnv, PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "tool-error-flag-key" },
			maxBuffer: 2 * 1024 * 1024,
		});
		assert.equal(child.status, 0, child.stderr);
		const { result, requests } = JSON.parse(child.stdout.trim().split("\n").at(-1));
		for (const url of requests) assert.match(url, /^https:\/\/api\.search\.brave\.com\//);
		return { result, requests };
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("fetch_content flags a missing url as an error result and names the received parameters", async () => {
	const { result } = await runTool("fetch_content", {});
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "No URL provided (received parameters: none). Use the 'url' parameter, or 'urls' for parallel fetches");
	assert.equal(result.content[0].text, "Error: No URL provided (received parameters: none). Use the 'url' parameter, or 'urls' for parallel fetches.");
});

test("fetch_content reports every validation problem at once, url first", async () => {
	// Mirrors the observed failure loop: arguments arrive with the url
	// dropped and mode/prompt/answerModel inconsistent. One aggregated
	// error must name the received parameters and every problem.
	const { result } = await runTool("fetch_content", { mode: "answer", answerModel: "gemini-3.6-flash" });
	assert.equal(result.isError, true);
	assert.equal(result.details.problems.length, 2);
	assert.match(result.content[0].text, /^Error: No URL provided \(received parameters: mode, answerModel\)\. Use the 'url' parameter, or 'urls' for parallel fetches; mode answer requires prompt\.$/);
});

test("fetch_content includes normalization problems in the aggregated error", async () => {
	// Regression: parameter-level normalization problems (mode, redirects,
	// auth, proxy) used to return early on their own, hiding the missing
	// URL and other constraint violations from the caller.
	const { result } = await runTool("fetch_content", { mode: "answer", auth: "" });
	assert.equal(result.isError, true);
	assert.equal(result.details.problems.length, 3);
	assert.match(
		result.content[0].text,
		/^Error: No URL provided \(received parameters: mode, auth\)\. Use the 'url' parameter, or 'urls' for parallel fetches; auth must be a profile name, true, or false; mode answer requires prompt\.$/,
	);
});

test("fetch_content flags invalid parameter combinations as error results", async () => {
	const { result } = await runTool("fetch_content", { url: "https://example.com", mode: "answer", prompt: "What is this page about?", model: "gemini-3.6-flash" });
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "use answerModel, not model, with mode answer");
	assert.equal(result.content[0].text, "Error: use answerModel, not model, with mode answer.");
});

test("web_search flags a missing query as an error result", async () => {
	const { result } = await runTool("web_search", { workflow: "none" });
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "No query provided");
	assert.equal(result.content[0].text, "Error: No query provided. Use 'query' or 'queries' parameter.");
});

test("source_check flags a missing claim as an error result", async () => {
	const { result } = await runTool("source_check", {});
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "Missing claim");
	assert.equal(result.content[0].text, "Error: 'claim' is required.");
});

test("get_search_content flags findMode without findText as an error result", async () => {
	const { result } = await runTool("get_search_content", { responseId: "nonexistent", findMode: "exact" });
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "findMode requires findText");
});

test("get_search_content flags an unknown responseId as an error result", async () => {
	const { result } = await runTool("get_search_content", { responseId: "no-such-response-id" });
	assert.equal(result.isError, true);
	assert.equal(result.details.error, "Not found");
	assert.match(result.content[0].text, /^Error: No stored results for responseId/);
});

test("web_search flags a call where every query failed as an error result", async () => {
	const { result, requests } = await runTool("web_search", { queries: ["fail one", "fail two"], provider: "brave", workflow: "none" });
	assert.equal(requests.length, 2);
	assert.equal(result.isError, true);
	assert.equal(result.details.queryCount, 2);
	assert.equal(result.details.successfulQueries, 0);
	assert.match(result.content[0].text, /Brave Search API error 401/);
});

test("web_search does not flag partial success or a successful search with zero results", async () => {
	const partial = await runTool("web_search", { queries: ["fail one", "works two"], provider: "brave", workflow: "none" });
	assert.equal(partial.requests.length, 2);
	assert.equal(partial.result.isError, undefined);
	assert.equal(partial.result.details.successfulQueries, 1);

	const empty = await runTool("web_search", { query: "empty results", provider: "brave", workflow: "none" });
	assert.equal(empty.requests.length, 1);
	assert.equal(empty.result.isError, undefined);
	assert.equal(empty.result.details.successfulQueries, 1);
});

test("source_check flags a call where every search failed as an error result", async () => {
	const { result, requests } = await runTool("source_check", { claim: "review claim", queries: ["fail one", "fail two"], provider: "brave" });
	assert.equal(requests.length, 2);
	assert.equal(result.isError, true);
	assert.equal(result.details.searchCount, 2);
	assert.equal(result.details.artifact.errors.length, 2);
});

test("source_check does not flag partial success or a successful search with zero results", async () => {
	const partial = await runTool("source_check", { claim: "review claim", queries: ["fail one", "works two"], provider: "brave" });
	assert.equal(partial.requests.length, 2);
	assert.equal(partial.result.isError, undefined);
	assert.equal(partial.result.details.artifact.errors.length, 1);

	const empty = await runTool("source_check", { claim: "review claim", queries: ["empty results"], provider: "brave" });
	assert.equal(empty.requests.length, 1);
	assert.equal(empty.result.isError, undefined);
	assert.equal(empty.result.details.sourceCount, 0);
});
