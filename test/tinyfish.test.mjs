import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const tinyfishModuleUrl = new URL("../tinyfish.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url)
	.href;

const PROVIDER_ENV_KEYS = [
	"OPENAI_API_KEY",
	"BRAVE_API_KEY",
	"PARALLEL_API_KEY",
	"TINYFISH_API_KEY",
	"TAVILY_API_KEY",
	"JINA_API_KEY",
	"SERPDIVE_API_KEY",
	"KAGI_API_KEY",
	"OLLAMA_API_KEY",
	"SERPBASE_API_KEY",
	"ANYSEARCH_API_KEY",
	"BRIGHTDATA_API_KEY",
	"BRIGHTDATA_SERP_ZONE",
	"SEARXNG_BASE_URL",
	"EXA_API_KEY",
	"PERPLEXITY_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"CLOUDFLARE_API_KEY",
	"FIRECRAWL_BASE_URL",
	"FIRECRAWL_API_KEY",
];

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tinyfish-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "web-search.json"),
		JSON.stringify(config) + "\n",
		"utf8",
	);
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	for (const key of PROVIDER_ENV_KEYS) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("TinyFish availability reads environment and config credentials", async () => {
	const emptyHome = await createHome();
	let child = runChild(
		`
		const { isTinyFishAvailable } = await import(${JSON.stringify(tinyfishModuleUrl)});
		console.log(String(isTinyFishAvailable()));
	`,
		{ HOME: emptyHome, USERPROFILE: emptyHome },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	child = runChild(
		`
		const { isTinyFishAvailable } = await import(${JSON.stringify(tinyfishModuleUrl)});
		console.log(String(isTinyFishAvailable()));
	`,
		{
			HOME: emptyHome,
			USERPROFILE: emptyHome,
			TINYFISH_API_KEY: "synthetic-tinyfish-env-key",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const configHome = await createHome({
		tinyfishApiKey: "synthetic-tinyfish-config-key",
	});
	child = runChild(
		`
		const { isTinyFishAvailable } = await import(${JSON.stringify(tinyfishModuleUrl)});
		console.log(String(isTinyFishAvailable()));
	`,
		{ HOME: configHome, USERPROFILE: configHome },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("explicit TinyFish search maps filters, results, and full inline content", async () => {
	const home = await createHome({ provider: "tinyfish" });
	const child = runChild(
		`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const urlText = String(url);
			const headers = Object.fromEntries(new Headers(init.headers));
			calls.push({ url: urlText, headers, body: init.body ? JSON.parse(init.body) : null });
			if (urlText.startsWith("https://api.search.tinyfish.ai?")) {
				return new Response(JSON.stringify({
					query: "tinyfish docs",
					results: [
						{ position: 1, site_name: "docs.tinyfish.ai", title: "TinyFish Docs", snippet: "  Search   and fetch  ", url: "https://docs.tinyfish.ai/" },
						{ position: 2, site_name: "example.com", title: "Second", snippet: "Second result", url: "https://example.com/second" },
					],
					total_results: 2,
					page: 0,
				}), { status: 200 });
			}
			if (urlText === "https://api.fetch.tinyfish.ai") {
				return new Response(JSON.stringify({
					results: [{ url: "https://docs.tinyfish.ai/", final_url: "https://docs.tinyfish.ai/", title: "TinyFish Docs", text: "# Full TinyFish documentation", format: "markdown" }],
					errors: [],
				}), { status: 200 });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("tinyfish docs", {
			provider: "tinyfish",
			includeContent: true,
			numResults: 1,
			recencyFilter: "week",
			domainFilter: ["docs.tinyfish.ai", "-example.com"],
		});
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			TINYFISH_API_KEY: "synthetic-tinyfish-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	const searchUrl = new URL(output.calls[0].url);
	assert.equal(
		searchUrl.origin + searchUrl.pathname,
		"https://api.search.tinyfish.ai/",
	);
	assert.equal(searchUrl.searchParams.get("query"), "tinyfish docs");
	assert.equal(
		searchUrl.searchParams.get("include_domains"),
		"docs.tinyfish.ai",
	);
	assert.equal(searchUrl.searchParams.get("exclude_domains"), "example.com");
	assert.equal(searchUrl.searchParams.get("recency_minutes"), "10080");
	assert.equal(
		output.calls[0].headers["x-api-key"],
		"synthetic-tinyfish-test-key",
	);
	assert.deepEqual(output.calls[1].body, {
		urls: ["https://docs.tinyfish.ai/"],
		format: "markdown",
		per_url_timeout_ms: 110000,
	});
	assert.equal(output.result.provider, "tinyfish");
	assert.deepEqual(output.result.results, [
		{
			title: "TinyFish Docs",
			url: "https://docs.tinyfish.ai/",
			snippet: "Search and fetch",
		},
	]);
	assert.deepEqual(output.result.inlineContent, [
		{
			url: "https://docs.tinyfish.ai/",
			title: "TinyFish Docs",
			content: "# Full TinyFish documentation",
			error: null,
		},
	]);
});

test("TinyFish search paginates when more than ten results are requested", async () => {
	const home = await createHome();
	const child = runChild(
		`
		const urls = [];
		globalThis.fetch = async (url) => {
			const parsed = new URL(String(url));
			urls.push(parsed.toString());
			const page = Number(parsed.searchParams.get("page") || 0);
			const start = page * 10;
			return new Response(JSON.stringify({
				query: "many",
				results: Array.from({ length: 10 }, (_, i) => ({ title: "Result " + (start + i), snippet: "Snippet", url: "https://example.com/" + (start + i) })),
				total_results: 10,
				page,
			}), { status: 200 });
		};
		const { searchWithTinyFish } = await import(${JSON.stringify(tinyfishModuleUrl)});
		const result = await searchWithTinyFish("many", { numResults: 15 });
		console.log(JSON.stringify({ urls, count: result.results.length, last: result.results.at(-1)?.url }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			TINYFISH_API_KEY: "synthetic-tinyfish-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.urls.length, 2);
	assert.equal(new URL(output.urls[1]).searchParams.get("page"), "1");
	assert.equal(output.count, 15);
	assert.equal(output.last, "https://example.com/14");
});

test("TinyFish extraction maps successful content and reports per-URL errors", async () => {
	const home = await createHome();
	const child = runChild(
		`
		let attempt = 0;
		const bodies = [];
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			attempt += 1;
			if (attempt === 1) {
				return new Response(JSON.stringify({
					results: [{ url: "https://example.com/good", final_url: "https://example.com/good", title: "Good", text: "# Rendered body", format: "markdown" }],
					errors: [],
				}), { status: 200 });
			}
			return new Response(JSON.stringify({
				results: [],
				errors: [{ url: "https://example.com/blocked", error: "bot_blocked", status: 403 }],
			}), { status: 200 });
		};
		const { extractWithTinyFish } = await import(${JSON.stringify(tinyfishModuleUrl)});
		const good = await extractWithTinyFish("https://example.com/good", undefined, { prompt: "Read the article", timeoutMs: 45000 });
		let error = "";
		try { await extractWithTinyFish("https://example.com/blocked"); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ bodies, good, error }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			TINYFISH_API_KEY: "synthetic-tinyfish-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.bodies[0], {
		urls: ["https://example.com/good"],
		format: "markdown",
		per_url_timeout_ms: 45000,
		purpose: "Read the article",
	});
	assert.deepEqual(output.good, {
		url: "https://example.com/good",
		title: "Good",
		content: "# Rendered body",
		error: null,
	});
	assert.match(
		output.error,
		/TinyFish Fetch failed .*bot_blocked \(HTTP 403\)/,
	);
});

test("TinyFish API errors redact credentials", async () => {
	const home = await createHome();
	const child = runChild(
		`
		globalThis.fetch = async () => new Response("rejected synthetic-tinyfish-secret", { status: 401 });
		const { searchWithTinyFish } = await import(${JSON.stringify(tinyfishModuleUrl)});
		let error = "";
		try { await searchWithTinyFish("redact me"); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			TINYFISH_API_KEY: "synthetic-tinyfish-secret",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /TinyFish Search API error 401/);
	assert.equal(output.error.includes("synthetic-tinyfish-secret"), false);
	assert.match(output.error, /\[redacted\]/i);
});

test("fetch_content uses TinyFish before Parallel after local and Jina extraction fail", async () => {
	const home = await createHome({
		fetchRouting: { allowRemoteHostedProviders: true },
	});
	const child = runChild(
		`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.com/app") {
				return new Response("<html><body><script></script><script></script><script></script><script></script>Loading</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) return new Response("", { status: 503 });
			if (urlText === "https://api.fetch.tinyfish.ai") {
				return new Response(JSON.stringify({
					results: [{ url: "https://example.com/app", final_url: "https://example.com/app", title: "Rendered", text: "# TinyFish rendered content", format: "markdown" }],
					errors: [],
				}), { status: 200 });
			}
			if (urlText === "https://api.parallel.ai/v1/extract") throw new Error("Parallel must not run");
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const result = await extractContent("https://example.com/app", undefined, { lookup });
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			TINYFISH_API_KEY: "synthetic-tinyfish-test-key",
			PARALLEL_API_KEY: "synthetic-parallel-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.com/app",
		"https://r.jina.ai/https://example.com/app",
		"https://api.fetch.tinyfish.ai",
	]);
	assert.deepEqual(output.result, {
		url: "https://example.com/app",
		title: "Rendered",
		content: "# TinyFish rendered content",
		error: null,
	});
});

test("configured searchRouting can select TinyFish", async () => {
	const home = await createHome({
		searchRouting: { providers: ["tinyfish"], fallbackOn: ["network"] },
	});
	const child = runChild(
		`
		globalThis.fetch = async () => new Response(JSON.stringify({
			query: "route",
			results: [{ title: "Routed", snippet: "TinyFish route", url: "https://example.com/routed" }],
			total_results: 1,
			page: 0,
		}), { status: 200 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, results: result.results }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: join(home, ".pi"),
			TINYFISH_API_KEY: "synthetic-tinyfish-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tinyfish");
	assert.equal(output.results[0].title, "Routed");
});

test("curator page exposes TinyFish as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["tinyfish query"],
		"session-token",
		20,
		{
			all: false,
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: true,
			tavily: false,
			serpdive: false,
			brightdata: false,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: false,
			kimi: false,
			anysearch: false,
		},
		"tinyfish",
		"tinyfish",
		[],
		null,
	);
	assert.match(page, /data-provider="tinyfish"/);
	assert.match(page, />TinyFish<\/button>/);
	assert.match(page, /provider-tag\.provider-tinyfish/);
});
