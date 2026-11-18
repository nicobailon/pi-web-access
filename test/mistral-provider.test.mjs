import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const mistralModuleUrl = new URL("../mistral-search.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-mistral-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "MISTRAL_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCHINFINITY_API_KEY",
		"QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY", "JINA_API_KEY",
		"KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY",
		"ANYSEARCH_API_KEY", "VALYU_API_KEY", "XAI_API_KEY",
		"BRIGHTDATA_API_KEY", "SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY",
		"GEMINI_API_KEY", "CLOUDFLARE_API_KEY", "GOOGLE_GEMINI_BASE_URL",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
		timeout: 15_000,
	});
}

function conversationBody() {
	return JSON.stringify({
		outputs: [
			{ type: "tool.execution", name: "web_search", ignored: true },
			{
				type: "message.output",
				content: [
					{ type: "text", text: "Mistral found the answer." },
					{ type: "tool_reference", tool: "web_search", title: "Mistral source", url: "https://example.com/source", description: "A useful source." },
					{ type: "text", text: "It returned references." },
				],
			},
		],
	});
}

test("Mistral sends the Conversations request and maps message text and references", async () => {
	const home = await createHome({ mistralApiKey: "mistral-test-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(conversationBody())}, { status: 200 });
		};
		const { searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
		const result = await searchWithMistral("what shipped?");
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());

	assert.equal(captured.url, "https://api.mistral.ai/v1/conversations");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.authorization, "Bearer mistral-test-key");
	assert.equal(captured.headers["content-type"], "application/json");
	assert.deepEqual(captured.body, {
		inputs: [{ role: "user", content: "what shipped?" }],
		stream: false,
		model: "mistral-small-latest",
		tools: [{ type: "web_search" }],
	});
	assert.equal(result.answer, "Mistral found the answer.\nIt returned references.");
	assert.deepEqual(result.results, [{
		title: "Mistral source",
		url: "https://example.com/source",
		snippet: "A useful source.",
	}]);
});

test("Mistral trims model config, opts into premium explicitly, and folds filters into the prompt", async () => {
	const home = await createHome({
		mistralApiKey: "mistral-test-key",
		mistralSearchModel: "  custom-mistral-model  ",
		mistralSearchTool: "web_search_premium",
	});
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => {
			captured = JSON.parse(init.body);
			return new Response(${JSON.stringify(conversationBody())}, { status: 200 });
		};
		const { searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
		await searchWithMistral("filtered query", { numResults: 3, recencyFilter: "week", domainFilter: [" docs.example.com ", "-ads.example.com"] });
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const body = JSON.parse(child.stdout.trim());
	assert.equal(body.model, "custom-mistral-model");
	assert.deepEqual(body.tools, [{ type: "web_search_premium" }]);
	assert.match(body.inputs[0].content, /past week/);
	assert.match(body.inputs[0].content, /Prefer up to 3 distinct sources/);
	assert.match(body.inputs[0].content, /Only use sources from: docs\.example\.com\./);
	assert.match(body.inputs[0].content, /Do not use sources from: ads\.example\.com\./);
	assert.match(body.inputs[0].content, /filtered query$/);
});

test("Mistral applies domain filtering, URL deduplication, null-URL skipping, and result limits locally", async () => {
	const home = await createHome({ mistralApiKey: "mistral-test-key" });
	const response = JSON.stringify({ outputs: [{ type: "message.output", content: [
		{ type: "tool_reference", tool: "web_search", title: "First", url: "https://docs.example.com/first", description: "first" },
		{ type: "tool_reference", tool: "web_search", title: "Duplicate", url: "https://docs.example.com/first", description: "duplicate" },
		{ type: "tool_reference", tool: "web_search", title: "Null URL", url: null, description: "ignored" },
		{ type: "tool_reference", tool: "web_search", title: "Blocked", url: "https://ads.example.com/blocked", description: "ignored" },
		{ type: "tool_reference", tool: "web_search", title: "Outside", url: "https://other.test/outside", description: "ignored" },
		{ type: "tool_reference", tool: "web_search", title: "Second", url: "https://example.com/second", description: "second" },
		{ type: "tool_reference", tool: "web_search", title: "Third", url: "https://example.com/third", description: "not kept" },
	] }] });
	const child = runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify(response)}, { status: 200 });
		const { searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
		const result = await searchWithMistral("local filters", { numResults: 2, domainFilter: ["example.com", "-ads.example.com"] });
		console.log(JSON.stringify(result));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.deepEqual(result.results, [
		{ title: "First", url: "https://docs.example.com/first", snippet: "first" },
		{ title: "Second", url: "https://example.com/second", snippet: "second" },
	]);
});

test("Mistral accepts config, environment, and trusted command credential sources", async () => {
	const cases = [
		{ config: { mistralApiKey: "config-key" }, env: {}, expected: "config-key" },
		{ config: {}, env: { MISTRAL_API_KEY: "environment-key" }, expected: "environment-key" },
		{ config: { mistralApiKey: "!printf command-key" }, env: {}, expected: "command-key" },
	];
	for (const [index, current] of cases.entries()) {
		const home = await createHome(current.config);
		const child = runChild(`
			let authorization;
			globalThis.fetch = async (_url, init) => {
				authorization = new Headers(init.headers).get("authorization");
				return new Response(${JSON.stringify(conversationBody())}, { status: 200 });
			};
			const { isMistralAvailable, searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
			const available = isMistralAvailable();
			await searchWithMistral("credential source");
			console.log(JSON.stringify({ available, authorization }));
		`, { PI_CODING_AGENT_DIR: home, ...current.env });
		assert.equal(child.status, 0, child.stderr || `credential case ${index}`);
		assert.deepEqual(JSON.parse(child.stdout.trim()), { available: true, authorization: `Bearer ${current.expected}` });
	}
});

test("Mistral rejects invalid model and tool configuration before making a request", async () => {
	for (const config of [
		{ mistralApiKey: "mistral-key", mistralSearchModel: 42 },
		{ mistralApiKey: "mistral-key", mistralSearchModel: "   " },
		{ mistralApiKey: "mistral-key", mistralSearchTool: null },
		{ mistralApiKey: "mistral-key", mistralSearchTool: "unknown" },
	]) {
		const home = await createHome(config);
		const child = runChild(`
			let requests = 0;
			globalThis.fetch = async () => { requests++; throw new Error("must not reach the network"); };
			const { isMistralAvailable, searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
			let message = "";
			try { await searchWithMistral("invalid config"); } catch (error) { message = String(error); }
			console.log(JSON.stringify({ available: isMistralAvailable(), requests, message }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.available, false);
		assert.equal(output.requests, 0);
		assert.match(output.message, /mistralSearch(?:Model|Tool)/);
	}
});

test("Mistral redacts credentials in HTTP and fetch errors", async () => {
	const home = await createHome({ mistralApiKey: "mistral-secret" });
	const child = runChild(`
		const { searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
		const messages = [];
		globalThis.fetch = async () => new Response("denied for mistral-secret", { status: 401 });
		try { await searchWithMistral("http error"); } catch (error) { messages.push(String(error)); }
		globalThis.fetch = async () => { throw new Error("fetch failed with mistral-secret"); };
		try { await searchWithMistral("fetch error"); } catch (error) { messages.push(String(error)); }
		console.log(JSON.stringify(messages));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const messages = JSON.parse(child.stdout.trim());
	assert.equal(messages.length, 2);
	for (const message of messages) {
		assert.doesNotMatch(message, /mistral-secret/);
		assert.match(message, /\[redacted\]/);
	}
});

test("Mistral rejects malformed and empty Conversations responses", async () => {
	const responses = [
		"{",
		JSON.stringify({}),
		JSON.stringify({ outputs: "not-an-array" }),
		JSON.stringify({ outputs: [] }),
		JSON.stringify({ outputs: [{ type: "message.output", content: [{ type: "unknown" }] }] }),
	];
	const home = await createHome({ mistralApiKey: "mistral-key" });
	const child = runChild(`
		import assert from "node:assert/strict";
		const { searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
		for (const response of ${JSON.stringify(responses)}) {
			globalThis.fetch = async () => new Response(response, { status: 200 });
			await assert.rejects(searchWithMistral("malformed"), /invalid JSON|invalid response|no answer or sources/i);
		}
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
});

test("Mistral propagates caller abort and passes the combined signal to fetch", async () => {
	const home = await createHome({ mistralApiKey: "mistral-key" });
	const child = runChild(`
		let capturedSignal;
		const controller = new AbortController();
		globalThis.fetch = async (_url, init) => {
			capturedSignal = init.signal;
			controller.abort();
			throw new DOMException("The operation was aborted", "AbortError");
		};
		const { searchWithMistral } = await import(${JSON.stringify(mistralModuleUrl)});
		let message = "";
		try { await searchWithMistral("cancel", { signal: controller.signal }); }
		catch (error) { message = String(error); }
		console.log(JSON.stringify({ aborted: capturedSignal?.aborted, message }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.aborted, true);
	assert.match(output.message, /abort/i);
});

test("Mistral works through explicit provider and configured searchRouting", async () => {
	const home = await createHome({
		mistralApiKey: "mistral-key",
		searchRouting: { providers: ["mistral"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response(${JSON.stringify(conversationBody())}, { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("routed", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "mistral",
		calls: ["https://api.mistral.ai/v1/conversations"],
	});

	const explicitHome = await createHome({});
	const explicitChild = runChild(`
		globalThis.fetch = async (url) => {
			if (String(url) !== "https://api.mistral.ai/v1/conversations") throw new Error("unexpected provider");
			return new Response(${JSON.stringify(conversationBody())}, { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("explicit", { provider: "mistral" });
		console.log(JSON.stringify({ provider: result.provider }));
	`, { PI_CODING_AGENT_DIR: explicitHome, MISTRAL_API_KEY: "environment-key" });
	assert.equal(explicitChild.status, 0, explicitChild.stderr);
	assert.deepEqual(JSON.parse(explicitChild.stdout.trim()), { provider: "mistral" });
});

test("Mistral is excluded from zero-config auto and provider all", async () => {
	const home = await createHome({ mistralApiKey: "mistral-key", braveApiKey: "brave-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://api.search.brave.com/res/v1/web/search?q=all&count=5") {
				return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "ok" }] } }), { status: 200 });
			}
			if (target === "https://api.mistral.ai/v1/conversations") throw new Error("Mistral must not run automatically");
			throw new Error("expected eligible provider failure: " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let autoError = "";
		try { await search("auto", { provider: "auto" }); } catch (error) { autoError = String(error); }
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({ autoError, allProvider: all.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.allProvider, "all");
	assert.ok(output.calls.every((url) => url !== "https://api.mistral.ai/v1/conversations"));
	assert.doesNotMatch(output.autoError, /Mistral/);
});

test("Curator page exposes Mistral as an available manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = {
		all: false,
		openai: false,
		brave: false,
		parallel: false,
		"parallel-mcp": false,
		tinyfish: false,
		searchinfinity: false,
		querit: false,
		tavily: false,
		firecrawl: false,
		jina: false,
		kagi: false,
		bocha: false,
		ollama: false,
		searxng: false,
		duckduckgo: false,
		perplexity: false,
		exa: false,
		gemini: false,
		kimi: false,
		anysearch: false,
		xai: false,
		mistral: true,
		valyu: false,
	};
	const page = generateCuratorPage(["query"], "token", 20, available, "mistral", "mistral", [], null);
	assert.match(page, /data-provider="mistral"/);
	assert.match(page, />Mistral<\/button>/);
	assert.match(page, /provider === "mistral"\) return "Mistral"/);
});
