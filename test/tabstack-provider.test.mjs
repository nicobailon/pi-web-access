import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = name => JSON.stringify(new URL(`../${name}.ts`, import.meta.url).href);
const RESEARCH = "https://api.tabstack.ai/v1/research";
const EXTRACT = "https://api.tabstack.ai/v1/extract/markdown";
const sse = events => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const COMPLETE = sse([
	["start", { message: "Starting research", timestamp: 1 }],
	["writing:end", { message: "Report draft complete", attempt: 1, timestamp: 2 }],
	["complete", {
		message: "Research complete",
		report: " Node.js 24 is the active LTS line [1][2]. ",
		metadata: {
			mode: "fast",
			citedPages: [
				{ id: "a", url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases", claims: [], sourceQueries: ["node lts"] },
				{ id: "b", url: "https://github.com/nodejs/node/releases", claims: ["24.22.1 is the latest LTS release"], sourceQueries: ["node lts"] },
				{ id: "c", url: "https://endoflife.date/nodejs", title: null, summary: "End-of-life dates for Node.js.", claims: [], sourceQueries: ["node lts"] },
			],
		},
		timestamp: 3,
	}],
]);
const sseResponse = body => `new Response(${JSON.stringify(body)}, { headers: { "content-type": "text/event-stream" } })`;

async function child(config, script, env = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tabstack-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify(config));
		const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|_KEY$|_BASE_URL$/.test(key)));
		const run = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: { ...base, PI_CODING_AGENT_DIR: home, HOME: home, USERPROFILE: home, ...env }, timeout: 20_000 });
		assert.equal(run.status, 0, run.stderr);
		return JSON.parse(run.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("Tabstack research posts the query in fast mode and returns the report with every cited page", async () => {
	const output = await child({ tabstackApiKey: "key" }, `
		const captured = [];
		globalThis.fetch = async (url, init) => { captured.push({ url: String(url), auth: init.headers.Authorization, accept: init.headers.Accept, body: JSON.parse(init.body) }); return ${sseResponse(COMPLETE)}; };
		const { searchWithTabstack } = await import(${moduleUrl("tabstack")});
		const full = await searchWithTabstack("node lts", { recencyFilter: "week", domainFilter: ["nodejs.org", "-github.com"] });
		const limited = await searchWithTabstack("node lts", { numResults: 1 });
		console.log(JSON.stringify({ captured, full, limited: limited.results.length }));
	`);
	assert.deepEqual(output.captured[0], { url: RESEARCH, auth: "Bearer key", accept: "text/event-stream", body: { query: "node lts", mode: "fast" } });
	assert.equal(output.full.answer, "Node.js 24 is the active LTS line [1][2].");
	assert.deepEqual(output.full.results, [
		{ title: "Node.js Releases", url: "https://nodejs.org/en/about/previous-releases", snippet: "" },
		{ title: "https://github.com/nodejs/node/releases", url: "https://github.com/nodejs/node/releases", snippet: "24.22.1 is the latest LTS release" },
		{ title: "https://endoflife.date/nodejs", url: "https://endoflife.date/nodejs", snippet: "End-of-life dates for Node.js." },
	]);
	// The report cites [1]..[n] in citedPages order, so numResults never drops a cited page.
	assert.equal(output.limited, 3);
});

test("Tabstack research parses CRLF frames and multi-line data fields", async () => {
	const stream = "event: start\r\ndata: {}\r\n\r\nevent: complete\r\ndata: {\"report\": \"Multi-line\",\r\ndata: \"metadata\": {\"citedPages\": [{\"url\": \"https://example.com/a\", \"title\": \"A\"}]}}\r\n\r\n";
	const output = await child({ tabstackApiKey: "key" }, `
		globalThis.fetch = async () => ${sseResponse(stream)};
		const { searchWithTabstack } = await import(${moduleUrl("tabstack")});
		const result = await searchWithTabstack("q");
		console.log(JSON.stringify(result));
	`);
	assert.deepEqual(output, { answer: "Multi-line", results: [{ title: "A", url: "https://example.com/a", snippet: "" }] });
});

test("Tabstack research mode, credentials, and availability come from config or TABSTACK_API_KEY", async () => {
	const output = await child({ tabstackResearchMode: "balanced" }, `
		let body;
		globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return ${sseResponse(COMPLETE)}; };
		const { searchWithTabstack, isTabstackAvailable } = await import(${moduleUrl("tabstack")});
		const available = isTabstackAvailable();
		await searchWithTabstack("q");
		console.log(JSON.stringify({ available, body }));
	`, { TABSTACK_API_KEY: "env-key" });
	assert.deepEqual(output, { available: true, body: { query: "q", mode: "balanced" } });

	const missing = await child({ tabstackResearchMode: "deep" }, `
		const { searchWithTabstack, isTabstackAvailable } = await import(${moduleUrl("tabstack")});
		let error; try { await searchWithTabstack("q"); } catch (e) { error = e.message; }
		console.log(JSON.stringify({ available: isTabstackAvailable(), error }));
	`);
	assert.equal(missing.available, false);
	assert.match(missing.error, /tabstackResearchMode .* must be one of: fast, balanced/);
});

test("Tabstack errors keep the HTTP status, redact the key, and surface stream error events", async () => {
	const output = await child({ tabstackApiKey: "secret" }, `
		const { searchWithTabstack, extractWithTabstack } = await import(${moduleUrl("tabstack")});
		const errors = [];
		for (const response of [
			() => new Response("bad key secret", { status: 401 }),
			() => ${sseResponse(sse([["start", {}], ["error", { message: "Research failed", error: { name: "Error", message: "search backend unavailable" }, timestamp: 1 }]]))},
			() => ${sseResponse(sse([["start", {}]]))},
		]) {
			globalThis.fetch = async () => response();
			try { await searchWithTabstack("q"); } catch (e) { errors.push(e.message); }
		}
		globalThis.fetch = async () => new Response("not json", { status: 200 });
		try { await extractWithTabstack("https://example.com"); } catch (e) { errors.push(e.message); }
		globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid key secret" }), { status: 401 });
		try { await extractWithTabstack("https://example.com"); } catch (e) { errors.push(e.message); }
		console.log(JSON.stringify(errors));
	`);
	assert.equal(output[0], "Tabstack Research API error 401: bad key [redacted]");
	assert.equal(output[1], "Tabstack Research API returned error: search backend unavailable");
	assert.match(output[2], /no complete event with a report/);
	assert.match(output[3], /^Tabstack Extract API returned invalid JSON/);
	assert.equal(output[4], 'Tabstack Extract API error 401: {"error":"invalid key [redacted]"}');
});

test("Tabstack research honors caller cancellation instead of reporting a timeout", async () => {
	const output = await child({ tabstackApiKey: "key" }, `
		globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.aborted ? reject(init.signal.reason) : init.signal.addEventListener("abort", () => reject(init.signal.reason)));
		const { searchWithTabstack } = await import(${moduleUrl("tabstack")});
		const controller = new AbortController();
		const pending = searchWithTabstack("q", { signal: controller.signal });
		controller.abort();
		let error; try { await pending; } catch (e) { error = { name: e.name, message: e.message }; }
		console.log(JSON.stringify(error));
	`);
	assert.equal(output.name, "AbortError");
	assert.doesNotMatch(output.message, /timed out/);
});

test("Tabstack reports its own deadline as a timeout", async () => {
	const output = await child({ tabstackApiKey: "key" }, `
		globalThis.fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
		const { extractWithTabstack } = await import(${moduleUrl("tabstack")});
		// AbortSignal.timeout does not keep the process alive on its own.
		const keepAlive = setTimeout(() => {}, 5_000);
		let error; try { await extractWithTabstack("https://example.com", undefined, { timeoutMs: 20 }); } catch (e) { error = { name: e.name, message: e.message }; }
		clearTimeout(keepAlive);
		console.log(JSON.stringify(error));
	`);
	assert.deepEqual(output, { name: "TimeoutError", message: "Tabstack Extract API request timed out after 1 seconds" });
});

test("Tabstack is explicit-only: it never joins auto or all, and searchRouting can fall back from it on quota", async () => {
	const output = await child({ tabstackApiKey: "k", webSearch: { allowedProviders: ["tabstack", "exa"] } }, `
		globalThis.fetch = async url => String(url) === ${JSON.stringify(RESEARCH)}
			? ${sseResponse(COMPLETE)}
			: new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }));
		const { search } = await import(${moduleUrl("gemini-search")});
		const explicit = await search("q", { provider: "tabstack" });
		const auto = await search("q", { provider: "auto" });
		const all = await search("q", { provider: "all" });
		console.log(JSON.stringify({ explicit: explicit.provider, auto: auto.provider, all: all.providerResponses.map(r => r.provider) }));
	`);
	assert.deepEqual(output, { explicit: "tabstack", auto: "exa", all: ["exa"] });

	const routed = await child({ tabstackApiKey: "k", tavilyApiKey: "t", searchRouting: { providers: ["tabstack", "tavily"], fallbackOn: ["quota"] } }, `
		globalThis.fetch = async url => String(url) === ${JSON.stringify(RESEARCH)}
			? new Response("slow down", { status: 429 })
			: new Response(JSON.stringify({ answer: "", results: [{ title: "Fallback", url: "https://example.com", content: "ok" }] }));
		const { search } = await import(${moduleUrl("gemini-search")});
		console.log(JSON.stringify((await search("q")).provider));
	`);
	assert.equal(routed, "tavily");
});

test("Tabstack Extract requests metadata and maps the title and Markdown", async () => {
	const output = await child({ tabstackApiKey: "key" }, `
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ url: "https://example.com/app", content: " # Rendered\\n\\nBody ", metadata: { title: " App " } }));
		};
		const { extractWithTabstack } = await import(${moduleUrl("tabstack")});
		const result = await extractWithTabstack("https://example.com/app");
		globalThis.fetch = async () => new Response(JSON.stringify({ url: "https://example.com/empty", content: "" }));
		const empty = await extractWithTabstack("https://example.com/empty");
		console.log(JSON.stringify({ captured, result, empty }));
	`);
	assert.deepEqual(output.captured, { url: EXTRACT, auth: "Bearer key", body: { url: "https://example.com/app", metadata: true } });
	assert.deepEqual(output.result, { url: "https://example.com/app", title: "App", content: "# Rendered\n\nBody", error: null });
	assert.equal(output.empty, null);
});

test("fetch_content uses Tabstack only when listed in fetchRouting.providers with remote hosted providers allowed", async () => {
	const script = `
		const calls = [];
		globalThis.fetch = async url => {
			const target = String(url);
			calls.push(target);
			if (target === "https://example.com/app") return new Response("<html><body><script></script>Loading</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			if (target === ${JSON.stringify(EXTRACT)}) return new Response(JSON.stringify({ url: "https://example.com/app", content: "# Tabstack rendered content", metadata: { title: "Rendered" } }));
			return new Response("", { status: 503 });
		};
		const { extractContent } = await import(${moduleUrl("extract")});
		const result = await extractContent("https://example.com/app", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
		console.log(JSON.stringify({ calls, result }));
	`;
	const listed = await child({ tabstackApiKey: "key", fetchRouting: { providers: ["http", "tabstack"], allowRemoteHostedProviders: true } }, script);
	assert.deepEqual(listed.calls, ["https://example.com/app", EXTRACT]);
	assert.deepEqual(listed.result, { url: "https://example.com/app", title: "Rendered", content: "# Tabstack rendered content", error: null });

	const defaultOrder = await child({ tabstackApiKey: "key", fetchRouting: { allowRemoteHostedProviders: true } }, script);
	assert.ok(!defaultOrder.calls.includes(EXTRACT));

	const notAllowed = await child({ tabstackApiKey: "key", fetchRouting: { providers: ["http", "tabstack"] } }, script);
	assert.ok(!notAllowed.calls.includes(EXTRACT));
});

test("curator page exposes Tabstack as a provider", async () => {
	const output = await child({}, `
		const { generateCuratorPage } = await import(${moduleUrl("curator-page")});
		const page = generateCuratorPage(["q"], "token", 20, { all: false, tabstack: true }, "tabstack", "tabstack", [], null);
		console.log(JSON.stringify({ button: page.includes('data-provider="tabstack"'), label: page.includes(">Tabstack</button>"), tag: page.includes("provider-tag.provider-tabstack") }));
	`);
	assert.deepEqual(output, { button: true, label: true, tag: true });
});
