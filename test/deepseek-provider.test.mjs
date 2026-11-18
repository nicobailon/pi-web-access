import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const deepseekModuleUrl = new URL("../deepseek.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function withHome(config, run) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-deepseek-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
		return await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY",
		"TINYFISH_API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY",
		"JINA_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SEARXNG_BASE_URL",
		"EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const page = (results) => JSON.stringify({ results });

test("DeepSeek posts the query with filters as operators and maps summaries to snippets", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const output = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(page([
				{ title: " Release ", url: "https://example.com/r", snippet: "short", summary: "Long\n\n  summary " + "x".repeat(900) },
				{ title: "Again", url: "https://example.com/r", snippet: "dup", summary: "dup" },
				{ title: "", url: "https://example.org/s", snippet: "only snippet", summary: "" },
				{ title: "File", url: "file:///tmp/x", snippet: "skipped", summary: "skipped" },
			]))});
		};
		const { searchWithDeepSeek, isDeepSeekAvailable } = await import(${JSON.stringify(deepseekModuleUrl)});
		const result = await searchWithDeepSeek("node release", { numResults: 8, recencyFilter: "week", domainFilter: ["example.com", "https://example.org/", "-spam.example.com"] });
		console.log(JSON.stringify({ captured, available: isDeepSeekAvailable(), result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.available, true);
	assert.equal(output.captured.url, "https://api.deepseek.com/v1/tools/search");
	assert.equal(output.captured.method, "POST");
	assert.equal(output.captured.headers.Authorization, "Bearer ds-key");
	assert.equal(output.captured.body.count, 8);
	assert.deepEqual(Object.keys(output.captured.body).sort(), ["count", "query"]);
	assert.match(output.captured.body.query, /^node release site:example\.com OR site:example\.org -site:spam\.example\.com after:\d{4}-\d{2}-\d{2}$/);
	const [release, untitled, ...rest] = output.result.results;
	assert.equal(release.title, "Release");
	assert.equal(release.snippet.length, 800);
	assert.ok(release.snippet.startsWith("Long summary x"));
	assert.deepEqual(untitled, { title: "Source 2", url: "https://example.org/s", snippet: "only snippet" });
	assert.deepEqual(rest, []);
	assert.match(output.result.answer, /Source: Release \(https:\/\/example\.com\/r\)/);
}));

test("DeepSeek needs a key, reads DEEPSEEK_API_KEY, and rejects queries over 128 characters before sending", async () => {
	await withHome({}, (home) => {
		const output = runChild(`
			const calls = [];
			globalThis.fetch = async (_url, init) => { calls.push(init.headers.Authorization); return new Response(${JSON.stringify(page([]))}); };
			const { searchWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
			const result = await searchWithDeepSeek("q");
			let tooLong;
			try { await searchWithDeepSeek("a".repeat(110), { domainFilter: ["example.com"], recencyFilter: "day" }); } catch (err) { tooLong = String(err); }
			console.log(JSON.stringify({ calls, results: result.results, tooLong }));
		`, { PI_CODING_AGENT_DIR: home, DEEPSEEK_API_KEY: "env-key" });
		assert.deepEqual(output.calls, ["Bearer env-key"]);
		assert.deepEqual(output.results, []);
		assert.match(output.tooLong, /query is 144 characters with domain and date filters; DeepSeek accepts at most 128/);
	});
	await withHome({}, (home) => {
		const output = runChild(`
			globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
			const { searchWithDeepSeek, isDeepSeekAvailable } = await import(${JSON.stringify(deepseekModuleUrl)});
			let error;
			try { await searchWithDeepSeek("q"); } catch (err) { error = String(err); }
			console.log(JSON.stringify({ available: isDeepSeekAvailable(), error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(output.available, false);
		assert.match(output.error, /DeepSeek API key not found/);
	});
});

// Source text for the child script: Exa's keyless MCP reply.
const exaReply = `new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 })`;

test("DeepSeek is selectable explicitly but excluded from auto and provider all", () => withHome({ deepseekApiKey: "k" }, (home) => {
	const output = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.deepseek.com/v1/tools/search") return new Response(${JSON.stringify(page([{ title: "DeepSeek", url: "https://example.com", snippet: "s", summary: "result" }]))});
			if (target.startsWith("https://mcp.exa.ai/mcp")) return ${exaReply};
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "deepseek" });
		const auto = await search("auto", { provider: "auto" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({ explicitProvider: explicit.provider, autoProvider: auto.provider, allProviders: all.providerResponses.map(r => r.provider), deepseekCalls: calls.filter(url => url.includes("deepseek")).length }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.explicitProvider, "deepseek");
	assert.equal(output.autoProvider, "exa");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.deepseekCalls, 1);
}));

test("DeepSeek balance and rate-limit errors fall back as quota failures in searchRouting", () => withHome({ deepseekApiKey: "k", searchRouting: { providers: ["deepseek", "exa"], fallbackOn: ["quota"] } }, (home) => {
	const output = runChild(`
		const statuses = [402, 429];
		globalThis.fetch = async (url) => {
			const target = String(url);
			if (target === "https://api.deepseek.com/v1/tools/search") return new Response(JSON.stringify({ error: { message: "nope", type: "x", param: null, code: "x" } }), { status: statuses.shift() });
			return ${exaReply};
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const providers = [(await search("one")).provider, (await search("two")).provider];
		console.log(JSON.stringify({ providers, left: statuses.length }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(output, { providers: ["exa", "exa"], left: 0 });
}));

test("DeepSeek reports API errors redacted and rejects malformed responses", () => withHome({ deepseekApiKey: "ds-secret" }, (home) => {
	const errors = runChild(`
		const responses = [
			new Response(JSON.stringify({ error: { message: "Insufficient Balance for ds-secret", type: "invalid_request_error", param: null, code: "invalid_request_error" } }), { status: 402 }),
			new Response(JSON.stringify({ data: [] })),
			new Response(JSON.stringify({ results: [{ url: null }, { url: "file:///tmp/x" }] })),
			new Response("not json"),
		];
		globalThis.fetch = async () => responses.shift();
		const { searchWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const errors = [];
		for (let i = 0; i < 4; i++) {
			try { await searchWithDeepSeek("broken"); } catch (error) { errors.push(String(error)); }
		}
		console.log(JSON.stringify(errors));
	`, { PI_CODING_AGENT_DIR: home });
	const [balance, malformed, unusable, json] = errors;
	assert.match(balance, /DeepSeek error 402: Insufficient Balance for \[redacted\]/);
	assert.doesNotMatch(balance, /ds-secret/);
	assert.match(malformed, /DeepSeek returned invalid response: expected a results array/);
	assert.match(unusable, /DeepSeek returned invalid response: no result had an http\(s\) URL/);
	assert.match(json, /DeepSeek returned invalid JSON/);
}));

test("DeepSeek appears in the Curator", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, deepseek: true }, { get: (target, property) => target[property] ?? false });
	const html = generateCuratorPage(["query"], "token", 20, available, "deepseek", "deepseek", [], null);
	assert.match(html, /data-provider="deepseek"/);
	assert.match(html, />DeepSeek<\/button>/);
	assert.match(html, /provider === "deepseek"\) return "DeepSeek"/);
});

test("DeepSeek includeContent requests native page content and maps inlineContent", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const output = runChild(`
		const bodies = [];
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return new Response(${JSON.stringify(page([
				{ title: "A", url: "https://example.com/a", summary: "sum", content: "  # A\n\nbody  " },
				{ title: "B", url: "https://example.com/b", summary: "sum-b", content: "" },
			]))});
		};
		const { searchWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const withContent = await searchWithDeepSeek("q", { includeContent: true });
		const without = await searchWithDeepSeek("q");
		console.log(JSON.stringify({ bodies, withContent, without }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(output.bodies, [
		{ query: "q", count: 5, need_content: true },
		{ query: "q", count: 5 },
	]);
	assert.deepEqual(output.withContent.inlineContent, [
		{ url: "https://example.com/a", title: "A", content: "# A\n\nbody", error: null },
	]);
	assert.equal(output.withContent.results.length, 2);
	assert.equal(output.without.inlineContent, undefined);
}));

test("DeepSeek Fetch posts the URL and maps Markdown content", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const output = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ title: " Example article ", content: "# Example article\\n\\nBody." }), { status: 200 });
		};
		const { extractWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const page = await extractWithDeepSeek("https://example.com/article", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
		console.log(JSON.stringify({ captured, page }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.captured.url, "https://api.deepseek.com/v1/tools/fetch");
	assert.equal(output.captured.method, "POST");
	assert.equal(output.captured.headers.Authorization, "Bearer ds-key");
	assert.deepEqual(output.captured.body, { url: "https://example.com/article" });
	assert.deepEqual(output.page, {
		url: "https://example.com/article",
		title: "Example article",
		content: "# Example article\n\nBody.",
		error: null,
	});
}));

test("DeepSeek Fetch redacts errors, returns null for empty content, and refuses private targets", () => withHome({ deepseekApiKey: "ds-secret" }, (home) => {
	const output = runChild(`
		const responses = [
			new Response(JSON.stringify({ error: { message: "policy rejected ds-secret" } }), { status: 403 }),
			new Response(JSON.stringify({ title: "empty", content: "" }), { status: 200 }),
		];
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); return responses.shift(); };
		const { extractWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		let error;
		try { await extractWithDeepSeek("https://example.com/x", undefined, { lookup }); } catch (err) { error = String(err); }
		const empty = await extractWithDeepSeek("https://example.com/y", undefined, { lookup });
		let privateError;
		try { await extractWithDeepSeek("http://127.0.0.1/admin", undefined, { lookup: async () => [{ address: "127.0.0.1", family: 4 }] }); } catch (err) { privateError = String(err); }
		console.log(JSON.stringify({ error, empty, privateError, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(output.error, /DeepSeek Fetch error 403: policy rejected \[redacted\]/);
	assert.doesNotMatch(output.error, /ds-secret/);
	assert.equal(output.empty, null);
	assert.match(output.privateError, /Blocked internal address/);
	assert.deepEqual(output.calls, ["https://api.deepseek.com/v1/tools/fetch", "https://api.deepseek.com/v1/tools/fetch"]);
}));

test("DeepSeek Fetch normalizes safe Markdown escapes while preserving code and link escapes", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const escaped = [
		"\\# Heading",
		"PARAM \\| VALUE",
		"https\\:\\/\\/example.com\\/a",
		"\\*literal\\* and \\`code\\` and \\[link\\]",
		"`\\# inline code`",
		"```",
		"\\# fenced",
		"```",
	].join("\n");
	const output = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ title: "Article", content: ${JSON.stringify(escaped)} }), { status: 200 });
		const { extractWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const page = await extractWithDeepSeek("https://example.com/article", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
		console.log(JSON.stringify(page));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.content, [
		"# Heading",
		"PARAM | VALUE",
		"https://example.com/a",
		"\\*literal\\* and \\`code\\` and \\[link\\]",
		"`\\# inline code`",
		"```",
		"\\# fenced",
		"```",
	].join("\n"));
}));

test("DeepSeek Fetch rejects error shells but keeps short valid pages", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const shell = "Search / Fetch API is now available. \\# Page Not Found We could not find what you were looking for.";
	const laterContent = "# HTTP status codes\n\n## 404 Not Found\n\nA real short page.\n\n```\n# 404 Not Found\n```";
	const output = runChild(`
		const responses = [
			new Response(JSON.stringify({ title: "Page Not Found", content: ${JSON.stringify(shell)} }), { status: 200 }),
			new Response(JSON.stringify({ title: "Bilibili", content: "Short but valid article body." }), { status: 200 }),
			new Response(JSON.stringify({ title: "404 Not Found - HTTP", content: "A real short reference page." }), { status: 200 }),
			new Response(JSON.stringify({ title: "HTTP status codes", content: ${JSON.stringify(laterContent)} }), { status: 200 }),
		];
		globalThis.fetch = async () => responses.shift();
		const { extractWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const missing = await extractWithDeepSeek("https://example.com/missing", undefined, { lookup });
		const short = await extractWithDeepSeek("https://example.com/short", undefined, { lookup });
		const titledLikeError = await extractWithDeepSeek("https://example.com/reference", undefined, { lookup });
		const laterErrorHeading = await extractWithDeepSeek("https://example.com/status-codes", undefined, { lookup });
		console.log(JSON.stringify({ missing, short, titledLikeError, laterErrorHeading }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.missing, null);
	assert.equal(output.short.content, "Short but valid article body.");
	assert.equal(output.titledLikeError.content, "A real short reference page.");
	assert.equal(output.laterErrorHeading.title, "HTTP status codes");
}));

test("DeepSeek search content keeps its backslashes", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const output = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			results: [{ title: "A", url: "https://example.com/a", summary: "sum", content: "\\\\(x \\\\in A\\\\) in C:\\\\temp\\\\.config" }],
		}), { status: 200 });
		const { searchWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const result = await searchWithDeepSeek("q", { includeContent: true });
		console.log(JSON.stringify(result.inlineContent));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output[0].content, "\\(x \\in A\\) in C:\\temp\\.config");
}));

test("DeepSeek fenced code requires the opening fence length to close", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const content = [
		"````",
		"```",
		"const re = /\\\\./;",
		"```",
		"````",
		"\\# outside",
	].join("\n");
	const output = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ title: "Article", content: ${JSON.stringify(content)} }), { status: 200 });
		const { extractWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const page = await extractWithDeepSeek("https://example.com/article", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
		console.log(JSON.stringify(page));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.content, [
		"````",
		"```",
		"const re = /\\\\./;",
		"```",
		"````",
		"# outside",
	].join("\n"));
}));

test("DeepSeek keeps a long article whose title starts with an error term", () => withHome({ deepseekApiKey: "ds-key" }, (home) => {
	const longBody = `# 404 Not Found\n\n${"Content sentence. ".repeat(40)}`;
	const output = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ title: "404 Not Found - HTTP", content: ${JSON.stringify(longBody)} }), { status: 200 });
		const { extractWithDeepSeek } = await import(${JSON.stringify(deepseekModuleUrl)});
		const page = await extractWithDeepSeek("https://example.com/reference", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
		console.log(JSON.stringify(page));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.title, "404 Not Found - HTTP");
	assert.equal(output.content, longBody.trim());
}));
