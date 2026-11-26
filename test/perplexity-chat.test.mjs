import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BASE = "https://gateway.example.com/v1";
const PAGE = "https://docs.example.com/api";
const KEY = "fixture-perplexity-secret";
const moduleUrl = name => JSON.stringify(new URL(`../${name}.ts`, import.meta.url).href);
const reply = payload => `Response.json(${JSON.stringify(payload)})`;
const chatReply = (content, fields = {}, messageFields = {}) => ({
	...fields,
	choices: [{ message: { role: "assistant", content, ...messageFields } }],
});

async function child(config, script) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-perplexity-chat-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify({
			perplexityBaseUrl: BASE,
			perplexityApiKey: KEY,
			perplexitySearchMode: "chat",
			...config,
		}));
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|_KEY$|^PERPLEXITY_/.test(key)));
		const run = spawnSync(process.execPath, ["--input-type=module"], {
			input: script,
			encoding: "utf8",
			env: { ...env, PI_CODING_AGENT_DIR: home, PI_WEB_ACCESS_CACHE_ROOT: join(home, "cache"), HOME: home, USERPROFILE: home },
			timeout: 20_000,
		});
		assert.equal(run.status, 0, run.stderr);
		return JSON.parse(run.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const load = `const { searchWithPerplexity } = await import(${moduleUrl("perplexity")});`;

test("omitting the mode preserves the Search API request and results", async () => {
	const output = await child({ perplexitySearchMode: undefined }, `
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), body: JSON.parse(init.body) };
			return ${reply({ results: [{ title: "Docs", url: PAGE, snippet: "Original excerpt" }] })};
		};
		${load}
		const result = await searchWithPerplexity("q", { numResults: 2 });
		console.log(JSON.stringify({ captured, result }));
	`);
	assert.deepEqual(output.captured, {
		url: `${BASE}/search`,
		body: { query: "q", max_results: 2, search_type: "fast", search_context_size: "medium" },
	});
	assert.deepEqual(output.result.results, [{ title: "Docs", url: PAGE, snippet: "Original excerpt" }]);
});

test("chat mode sends the Sonar model, filters and Bearer auth to chat/completions", async () => {
	const output = await child({ perplexityBaseUrl: `${BASE}/`, perplexityChatModel: "gateway/sonar-pro" }, `
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) };
			return ${reply(chatReply("Answer [1]", { citations: [PAGE] }))};
		};
		${load}
		await searchWithPerplexity("q", { numResults: 2, recencyFilter: "week", domainFilter: ["example.com"] });
		console.log(JSON.stringify(captured));
	`);
	assert.deepEqual(output, {
		url: `${BASE}/chat/completions`, auth: `Bearer ${KEY}`,
		body: { model: "gateway/sonar-pro", messages: [{ role: "user", content: "q" }], stream: false, max_tokens: 1024, search_domain_filter: ["example.com"], search_recency_filter: "week" },
	});
});

test("native citations use search_results metadata but never generated prose as snippets", async () => {
	const output = await child({}, `
		let model;
		globalThis.fetch = async (_url, init) => {
			model = JSON.parse(init.body).model;
			return ${reply(chatReply("Generated answer [1].", {
				citations: [PAGE], search_results: [{ title: "API docs", url: PAGE, snippet: "Unverified provider snippet" }],
			}))};
		};
		${load}
		console.log(JSON.stringify({ result: await searchWithPerplexity("q"), model }));
	`);
	assert.equal(output.model, "sonar");
	assert.deepEqual(output.result.results, [{ title: "API docs", url: PAGE, snippet: "" }]);
	assert.equal(output.result.answer, `Generated answer [1](<${PAGE}>).`);
});

test("gateway citations retain non-sequential ref_id values and collapse duplicate URLs", async () => {
	const output = await child({}, `
		globalThis.fetch = async () => ${reply(chatReply("Answer [7] [2] [9].", {}, {
			extensions: { citations: [
				{ ref_id: 7, title: "API docs", url: PAGE },
				{ ref_id: 2, title: "Duplicate", url: PAGE },
				{ ref_id: 9, title: "Other", url: "https://example.org/other" },
			] },
		}))};
		${load}
		console.log(JSON.stringify(await searchWithPerplexity("q")));
	`);
	assert.deepEqual(output.results.map(result => result.url), [PAGE, "https://example.org/other"]);
	assert.equal(output.answer, `Answer [7](<${PAGE}>) [2](<${PAGE}>) [9](<https://example.org/other>).`);
	assert.ok(output.results.every(result => result.snippet === ""));
});

test("invalid URLs are ignored, limits do not renumber citations, and missing references are explicit", async () => {
	const output = await child({}, `
		globalThis.fetch = async () => ${reply(chatReply("Answer [1] [3] [4] [5] [6] [99].", {
			citations: ["javascript:alert(1)", "https://user:password@example.com/secret", PAGE, PAGE, "https://example.org/", "not-a-url"],
		}))};
		${load}
		console.log(JSON.stringify(await searchWithPerplexity("q", { numResults: 1 })));
	`);
	assert.equal(output.results.length, 1);
	assert.equal(output.results[0].url, PAGE);
	assert.equal(output.answer, `Answer [citation 1 unavailable] [3](<${PAGE}>) [4](<${PAGE}>) [citation 5 unavailable] [citation 6 unavailable] [citation 99 unavailable].`);
});

test("conflicting citation IDs never link to an arbitrarily chosen source", async () => {
	const output = await child({}, `
		globalThis.fetch = async () => ${reply(chatReply("Answer [1]", { citations: [PAGE] }, {
			extensions: { citations: [{ ref_id: 1, url: "https://example.org/" }] },
		}))};
		${load}
		console.log(JSON.stringify(await searchWithPerplexity("q")));
	`);
	assert.equal(output.answer, "Answer [citation 1 unavailable]");
	assert.equal(output.results.length, 2);
});

test("uncited search_results remain usable sources without inventing citation IDs", async () => {
	const output = await child({}, `
		globalThis.fetch = async () => ${reply(chatReply("", { search_results: [{ title: "API", url: PAGE }] }))};
		${load}
		console.log(JSON.stringify(await searchWithPerplexity("q")));
	`);
	assert.deepEqual(output.results, [{ title: "API", url: PAGE, snippet: "" }]);
	assert.match(output.answer, /API/);
});

test("domain filtering drops excluded sources and prose that could cite them", async () => {
	const output = await child({}, `
		globalThis.fetch = async () => ${reply(chatReply("Generated mixed-domain answer [1] [2] [3].", {
			citations: [PAGE, "https://other.org/", "https://blocked.example.com/"],
		}))};
		${load}
		console.log(JSON.stringify(await searchWithPerplexity("q", { domainFilter: ["example.com", "-blocked.example.com"] })));
	`);
	assert.deepEqual(output.results.map(result => result.url), [PAGE]);
	assert.doesNotMatch(output.answer, /Generated|other\.org|blocked\.example/);
});

test("a citation-free response invents no results or passages, and domain filters fail closed", async () => {
	const output = await child({}, `
		globalThis.fetch = async () => ${reply(chatReply("Unsupported model assertion."))};
		${load}
		const plain = await searchWithPerplexity("q");
		const filtered = await searchWithPerplexity("q", { domainFilter: ["example.com"] });
		console.log(JSON.stringify({ plain, filtered }));
	`);
	assert.deepEqual(output.plain, { answer: "Unsupported model assertion.", results: [] });
	assert.deepEqual(output.filtered, { answer: "", results: [] });
});

test("invalid mode, model and gateway config fail before making any request", async () => {
	for (const [config, expected] of [
		[{ perplexitySearchMode: "typo" }, /perplexitySearchMode/],
		[{ perplexitySearchMode: null }, /perplexitySearchMode/],
		[{ perplexityChatModel: " " }, /perplexityChatModel/],
		[{ perplexityChatModel: 123 }, /perplexityChatModel/],
		[{ perplexityBaseUrl: "https://user:pass@example.com/v1" }, /credential|username|password/i],
	]) {
		const output = await child(config, `
			let calls = 0;
			globalThis.fetch = async () => { calls++; throw new Error("should not fetch"); };
			${load}
			let error; try { await searchWithPerplexity("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify({ calls, error }));
		`);
		assert.equal(output.calls, 0);
		assert.match(output.error, expected);
	}
});

test("malformed chat responses and invalid JSON are not successful empty searches", async () => {
	for (const response of ["null", "{}", JSON.stringify({ choices: [{ message: { content: null } }] }), "not json"]) {
		const output = await child({}, `
			globalThis.fetch = async () => new Response(${JSON.stringify(response)});
			${load}
			let error; try { await searchWithPerplexity("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify(error));
		`);
		assert.match(output, /invalid (response|JSON)/);
	}
});

test("chat mode preserves status errors, credential redaction and cross-origin redirect stripping", async () => {
	for (const status of [401, 429]) {
		const output = await child({}, `
			globalThis.fetch = async () => new Response(${JSON.stringify(`bad key ${KEY}`)}, { status: ${status} });
			${load}
			let error; try { await searchWithPerplexity("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify(error));
		`);
		assert.equal(output, `Perplexity API error ${status}: bad key [redacted]`);
	}
	const redirected = await child({}, `
		const auth = [];
		globalThis.fetch = async (_url, init) => {
			auth.push(new Headers(init.headers).get("Authorization"));
			return auth.length === 1 ? new Response(null, { status: 307, headers: { location: "https://other.example.com/chat" } }) : ${reply(chatReply("ok"))};
		};
		${load}
		await searchWithPerplexity("q");
		console.log(JSON.stringify(auth));
	`);
	assert.deepEqual(redirected, [`Bearer ${KEY}`, null]);
});

test("chat mode keeps request/body deadlines distinct from caller cancellation", async () => {
	for (const stage of ["headers", "body", "caller"]) {
		const output = await child({}, `
			const deadline = new AbortController();
			const caller = new AbortController();
			AbortSignal.timeout = () => deadline.signal;
			const fail = signal => {
				if (${JSON.stringify(stage)} === "caller") caller.abort();
				else deadline.abort(new DOMException("timeout", "TimeoutError"));
				throw signal.reason;
			};
			globalThis.fetch = async (_url, init) => ${JSON.stringify(stage)} === "body"
				? { ok: true, status: 200, json: async () => fail(init.signal) }
				: fail(init.signal);
			${load}
			let error; try { await searchWithPerplexity("q", { signal: caller.signal }); } catch (e) { error = { name: e.name, message: e.message }; }
			console.log(JSON.stringify(error));
		`);
		if (stage === "caller") assert.equal(output.name, "AbortError");
		else assert.equal(output.message, "Perplexity API error 408: request timed out");
	}
});

test("the normal router and source_check use chat mode without laundering the answer into evidence", async () => {
	const output = await child({ provider: "perplexity" }, `
		globalThis.fetch = async () => ${reply(chatReply("The API supports streaming responses [1].", { citations: [PAGE] }))};
		const { search } = await import(${moduleUrl("gemini-search")});
		const routed = await search("streaming");
		const { default: initializeExtension } = await import(${moduleUrl("index")});
		const tools = [];
		initializeExtension({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
		const tool = tools.find(t => t.name === "source_check");
		const response = await tool.execute("call", { claim: "API supports streaming responses", fetchContent: false }, undefined, undefined, { modelRegistry: {} });
		const { buildResearchArtifact } = await import(${moduleUrl("source-check")});
		const fetched = buildResearchArtifact({ query: "API supports streaming responses", results: routed.results,
			fetched: [{ url: ${JSON.stringify(PAGE)}, title: "API", content: "The API supports streaming responses.", error: null }] });
		console.log(JSON.stringify({ provider: routed.provider, details: response.details, fetchedPassages: fetched.passages }));
	`);
	assert.equal(output.provider, "perplexity");
	assert.equal(output.details.sourceCount, 1);
	assert.equal(output.details.passageCount, 0);
	assert.equal(output.details.artifact.claims[0].status, "missing-evidence");
	assert.ok(output.fetchedPassages.length > 0);
	assert.equal(output.fetchedPassages[0].text, "The API supports streaming responses.");
	assert.ok(output.fetchedPassages[0].extraction_span);
});
