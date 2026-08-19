import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const search1apiModuleUrl = new URL("../search1api.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url)
	.href;

const PROVIDER_ENV_KEYS = [
	"OPENAI_API_KEY",
	"BRAVE_API_KEY",
	"PARALLEL_API_KEY",
	"TINYFISH_API_KEY",
	"SEARCH1API_KEY",
	"QUERIT_API_KEY",
	"TAVILY_API_KEY",
	"JINA_API_KEY",
	"SERPDIVE_API_KEY",
	"KAGI_API_KEY",
	"OLLAMA_API_KEY",
	"SERPBASE_API_KEY",
	"ANYSEARCH_API_KEY",
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
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-search1api-"));
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

test("Search1API availability reads environment and config credentials", async () => {
	const emptyHome = await createHome();
	let child = runChild(
		`
		const { isSearch1APIAvailable } = await import(${JSON.stringify(search1apiModuleUrl)});
		console.log(String(isSearch1APIAvailable()));
	`,
		{ HOME: emptyHome, USERPROFILE: emptyHome },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	child = runChild(
		`
		const { isSearch1APIAvailable } = await import(${JSON.stringify(search1apiModuleUrl)});
		console.log(String(isSearch1APIAvailable()));
	`,
		{
			HOME: emptyHome,
			USERPROFILE: emptyHome,
			SEARCH1API_KEY: "synthetic-search1api-env-key",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const configHome = await createHome({
		search1apiApiKey: "synthetic-search1api-config-key",
	});
	child = runChild(
		`
		const { isSearch1APIAvailable } = await import(${JSON.stringify(search1apiModuleUrl)});
		console.log(String(isSearch1APIAvailable()));
	`,
		{ HOME: configHome, USERPROFILE: configHome },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("Search1API resolves command credentials only when a request starts", async () => {
	const markerDir = await mkdtemp(
		join(tmpdir(), "pi-web-access-search1api-marker-"),
	);
	const marker = join(markerDir, "ran");
	const home = await createHome({
		search1apiApiKey: `!touch ${marker} && printf synthetic-search1api-command-key`,
	});
	const child = runChild(
		`
		import { existsSync } from "node:fs";
		const { isSearch1APIAvailable, searchWithSearch1API } = await import(${JSON.stringify(search1apiModuleUrl)});
		const availableBefore = isSearch1APIAvailable();
		const ranBefore = existsSync(${JSON.stringify(marker)});
		let authorization = "";
		globalThis.fetch = async (_url, init) => {
			authorization = new Headers(init.headers).get("authorization") || "";
			return new Response(JSON.stringify({ searchParameters: {}, results: [] }), { status: 200 });
		};
		await searchWithSearch1API("credential timing");
		console.log(JSON.stringify({ availableBefore, ranBefore, ranAfter: existsSync(${JSON.stringify(marker)}), authorization }));
	`,
		{ HOME: home, USERPROFILE: home },
	);

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		availableBefore: true,
		ranBefore: false,
		ranAfter: true,
		authorization: "Bearer synthetic-search1api-command-key",
	});
	assert.equal(existsSync(marker), true);
});

test("explicit Search1API search maps filters, deep content, and results", async () => {
	const home = await createHome({ provider: "search1api" });
	const child = runChild(
		`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({
				url: String(url),
				headers: Object.fromEntries(new Headers(init.headers)),
				body: JSON.parse(init.body),
			});
			return new Response(JSON.stringify({
				searchParameters: { query: "search1api docs", max_results: 1 },
				results: [{
					title: "Search1API Docs",
					link: "https://www.search1api.com/docs",
					snippet: "  Search,   crawl, and extract. ",
					content: "# Full Search1API documentation",
				}],
			}), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("search1api docs", {
			provider: "search1api",
			includeContent: true,
			numResults: 1,
			recencyFilter: "week",
			domainFilter: ["https://www.search1api.com/docs", "-example.com"],
		});
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			SEARCH1API_KEY: "synthetic-search1api-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		{
			url: "https://api.search1api.com/search",
			headers: {
				authorization: "Bearer synthetic-search1api-test-key",
				"content-type": "application/json",
			},
			body: {
				query: "search1api docs",
				max_results: 1,
				crawl_results: 1,
				include_sites: ["www.search1api.com"],
				exclude_sites: ["example.com"],
				time_range: "week",
			},
		},
	]);
	assert.equal(output.result.provider, "search1api");
	assert.deepEqual(output.result.results, [
		{
			title: "Search1API Docs",
			url: "https://www.search1api.com/docs",
			snippet: "Search, crawl, and extract.",
		},
	]);
	assert.deepEqual(output.result.inlineContent, [
		{
			url: "https://www.search1api.com/docs",
			title: "Search1API Docs",
			content: "# Full Search1API documentation",
			error: null,
		},
	]);
});

test("Search1API search does not request paid page crawling unless includeContent is true", async () => {
	const home = await createHome();
	const child = runChild(
		`
		let body = null;
		globalThis.fetch = async (_url, init) => {
			body = JSON.parse(init.body);
			return new Response(JSON.stringify({ searchParameters: {}, results: [] }), { status: 200 });
		};
		const { searchWithSearch1API } = await import(${JSON.stringify(search1apiModuleUrl)});
		await searchWithSearch1API("basic search", { numResults: 20 });
		console.log(JSON.stringify(body));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			SEARCH1API_KEY: "synthetic-search1api-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		query: "basic search",
		max_results: 20,
		crawl_results: 0,
	});
});

test("Search1API Crawl maps extracted content", async () => {
	const home = await createHome();
	const child = runChild(
		`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({
				url: String(url),
				headers: Object.fromEntries(new Headers(init.headers)),
				body: JSON.parse(init.body),
			});
			return new Response(JSON.stringify({
				crawlParameters: { url: "https://example.com/article" },
				results: {
					title: "Example article",
					link: "https://example.com/article",
					content: "# Article body",
					metadata: { language: "en" },
				},
			}), { status: 200 });
		};
		const { extractWithSearch1API } = await import(${JSON.stringify(search1apiModuleUrl)});
		const result = await extractWithSearch1API("https://example.com/article", undefined, { timeoutMs: 45000 });
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			SEARCH1API_KEY: "synthetic-search1api-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		{
			url: "https://api.search1api.com/crawl",
			headers: {
				authorization: "Bearer synthetic-search1api-test-key",
				"content-type": "application/json",
			},
			body: { url: "https://example.com/article" },
		},
	]);
	assert.deepEqual(output.result, {
		url: "https://example.com/article",
		title: "Example article",
		content: "# Article body",
		error: null,
	});
});

test("Search1API errors redact credentials", async () => {
	const home = await createHome();
	const child = runChild(
		`
		globalThis.fetch = async () => new Response("rejected synthetic-search1api-secret", { status: 401 });
		const { searchWithSearch1API } = await import(${JSON.stringify(search1apiModuleUrl)});
		let error = "";
		try { await searchWithSearch1API("redact me"); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			SEARCH1API_KEY: "synthetic-search1api-secret",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Search1API Search API error 401/);
	assert.equal(output.error.includes("synthetic-search1api-secret"), false);
	assert.match(output.error, /\[redacted\]/i);
});

test("fetch_content uses Search1API after local and Jina extraction fail", async () => {
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
			if (urlText === "https://api.search1api.com/crawl") {
				return new Response(JSON.stringify({
					crawlParameters: { url: "https://example.com/app" },
					results: { title: "Rendered", link: "https://example.com/app", content: "# Search1API rendered content" },
				}), { status: 200 });
			}
			if (urlText === "https://api.parallel.ai/v1/extract") throw new Error("Parallel must not run");
			throw new Error("Unexpected fetch " + urlText + " " + String(init.method || "GET"));
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const result = await extractContent("https://example.com/app", undefined, { lookup });
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			SEARCH1API_KEY: "synthetic-search1api-test-key",
			PARALLEL_API_KEY: "synthetic-parallel-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.com/app",
		"https://r.jina.ai/https://example.com/app",
		"https://api.search1api.com/crawl",
	]);
	assert.deepEqual(output.result, {
		url: "https://example.com/app",
		title: "Rendered",
		content: "# Search1API rendered content",
		error: null,
	});
});

test("configured searchRouting can select Search1API", async () => {
	const home = await createHome({
		searchRouting: { providers: ["search1api"], fallbackOn: ["network"] },
	});
	const child = runChild(
		`
		globalThis.fetch = async () => new Response(JSON.stringify({
			searchParameters: { query: "route" },
			results: [{ title: "Routed", snippet: "Search1API route", link: "https://example.com/routed" }],
		}), { status: 200 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, results: result.results }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: join(home, ".pi"),
			SEARCH1API_KEY: "synthetic-search1api-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "search1api");
	assert.equal(output.results[0].title, "Routed");
});

test("curator page exposes Search1API as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["search1api query"],
		"session-token",
		20,
		{
			all: false,
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: false,
			search1api: true,
			querit: false,
			tavily: false,
			serpdive: false,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: false,
			kimi: false,
			anysearch: false,
		},
		"search1api",
		"search1api",
		[],
		null,
	);
	assert.match(page, /data-provider="search1api"/);
	assert.match(page, />Search1API<\/button>/);
	assert.match(page, /provider-tag\.provider-search1api/);
});
