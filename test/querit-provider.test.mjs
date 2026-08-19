import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const queritModuleUrl = new URL("../querit.ts", import.meta.url).href;
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
	"FIRECRAWL_BASE_URL",
	"FIRECRAWL_API_KEY",
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
];

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-querit-"));
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

test("Querit availability reads environment and config credentials", async () => {
	const emptyHome = await createHome();
	let child = runChild(
		`
		const { isQueritAvailable } = await import(${JSON.stringify(queritModuleUrl)});
		console.log(String(isQueritAvailable()));
	`,
		{ HOME: emptyHome, USERPROFILE: emptyHome },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	child = runChild(
		`
		const { isQueritAvailable } = await import(${JSON.stringify(queritModuleUrl)});
		console.log(String(isQueritAvailable()));
	`,
		{
			HOME: emptyHome,
			USERPROFILE: emptyHome,
			QUERIT_API_KEY: "synthetic-querit-env-key",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const configHome = await createHome({
		queritApiKey: "synthetic-querit-config-key",
	});
	child = runChild(
		`
		const { isQueritAvailable } = await import(${JSON.stringify(queritModuleUrl)});
		console.log(String(isQueritAvailable()));
	`,
		{ HOME: configHome, USERPROFILE: configHome },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("Querit resolves command credentials only when a request starts", async () => {
	const markerDir = await mkdtemp(
		join(tmpdir(), "pi-web-access-querit-marker-"),
	);
	const marker = join(markerDir, "ran");
	const home = await createHome({
		queritApiKey: `!touch ${marker} && printf synthetic-querit-command-key`,
	});
	const child = runChild(
		`
		import { existsSync } from "node:fs";
		const { isQueritAvailable, searchWithQuerit } = await import(${JSON.stringify(queritModuleUrl)});
		const availableBefore = isQueritAvailable();
		const ranBefore = existsSync(${JSON.stringify(marker)});
		let authorization = "";
		globalThis.fetch = async (_url, init) => {
			authorization = new Headers(init.headers).get("authorization") || "";
			return new Response(JSON.stringify({ error_code: 200, error_msg: "", search_id: 1, results: { result: [] } }), { status: 200 });
		};
		await searchWithQuerit("credential timing");
		console.log(JSON.stringify({ availableBefore, ranBefore, ranAfter: existsSync(${JSON.stringify(marker)}), authorization }));
	`,
		{ HOME: home, USERPROFILE: home },
	);

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		availableBefore: true,
		ranBefore: false,
		ranAfter: true,
		authorization: "Bearer synthetic-querit-command-key",
	});
	assert.equal(existsSync(marker), true);
});

test("Querit search maps SDK filters and retrieves inline contents", async () => {
	const home = await createHome();
	const child = runChild(
		`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({
				url: String(url),
				headers: Object.fromEntries(new Headers(init.headers)),
				body: JSON.parse(init.body),
			});
			if (String(url).endsWith("/v1/search")) {
				return new Response(JSON.stringify({
					error_code: 200,
					error_msg: "",
					search_id: 101,
					results: { result: [{
						title: "Querit docs",
						url: "https://www.querit.ai/en/docs",
						snippet: "  Real-time   search for LLMs. ",
						page_age: "1 day ago",
					}] },
				}), { status: 200 });
			}
			return new Response(JSON.stringify({
				error_code: 200,
				error_msg: "",
				search_id: 102,
				results: [{
					id: "fetch-1",
					url: "https://www.querit.ai/en/docs",
					content: "# Full Querit documentation",
					extrasMeta: { title: "Querit Documentation", url: "https://www.querit.ai/en/docs" },
				}],
				statuses: [{ id: "fetch-1", status: "success" }],
				searchTime: 1,
			}), { status: 200 });
		};
		const { searchWithQuerit } = await import(${JSON.stringify(queritModuleUrl)});
		const result = await searchWithQuerit("querit docs", {
			includeContent: true,
			numResults: 1,
			recencyFilter: "week",
			domainFilter: ["https://www.querit.ai/docs", "-example.com"],
		});
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			QUERIT_API_KEY: "synthetic-querit-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		{
			url: "https://api.querit.ai/v1/search",
			headers: {
				authorization: "Bearer synthetic-querit-test-key",
				accept: "application/json",
				"content-type": "application/json",
			},
			body: {
				query: "querit docs",
				count: 1,
				filters: {
					sites: { include: ["www.querit.ai"], exclude: ["example.com"] },
					timeRange: { date: "w1" },
				},
			},
		},
		{
			url: "https://api.querit.ai/v1/contents",
			headers: {
				authorization: "Bearer synthetic-querit-test-key",
				accept: "application/json",
				"content-type": "application/json",
			},
			body: {
				urls: ["https://www.querit.ai/en/docs"],
				format: "markdown",
				crawlTimeout: 10,
				extrasMeta: true,
			},
		},
	]);
	assert.deepEqual(output.result.results, [
		{
			title: "Querit docs",
			url: "https://www.querit.ai/en/docs",
			snippet: "Real-time search for LLMs.",
		},
	]);
	assert.deepEqual(output.result.inlineContent, [
		{
			url: "https://www.querit.ai/en/docs",
			title: "Querit Documentation",
			content: "# Full Querit documentation",
			error: null,
		},
	]);
});

test("Querit contents requests are batched at ten URLs", async () => {
	const home = await createHome();
	const child = runChild(
		`
		const contentBatches = [];
		globalThis.fetch = async (url, init = {}) => {
			const body = JSON.parse(init.body);
			if (String(url).endsWith("/v1/search")) {
				return new Response(JSON.stringify({
					error_code: 200,
					error_msg: "",
					search_id: 1,
					results: { result: Array.from({ length: 11 }, (_, index) => ({
						title: "Result " + index,
						url: "https://example.com/" + index,
						snippet: "Snippet " + index,
					})) },
				}), { status: 200 });
			}
			contentBatches.push(body.urls);
			return new Response(JSON.stringify({
				error_code: 200,
				error_msg: "",
				search_id: 2,
				results: body.urls.map((itemUrl, index) => ({ id: "id-" + index, url: itemUrl, content: "Content " + itemUrl })),
				statuses: body.urls.map((_, index) => ({ id: "id-" + index, status: "success" })),
				searchTime: 1,
			}), { status: 200 });
		};
		const { searchWithQuerit } = await import(${JSON.stringify(queritModuleUrl)});
		const result = await searchWithQuerit("batch", { includeContent: true, numResults: 11 });
		console.log(JSON.stringify({ contentBatches, inlineCount: result.inlineContent?.length }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			QUERIT_API_KEY: "synthetic-querit-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(
		output.contentBatches.map((batch) => batch.length),
		[10, 1],
	);
	assert.equal(output.inlineCount, 11);
});

test("Querit extraction maps contents metadata and timeout", async () => {
	const home = await createHome();
	const child = runChild(
		`
		let call = null;
		globalThis.fetch = async (url, init = {}) => {
			call = { url: String(url), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				error_code: 200,
				error_msg: "",
				search_id: 201,
				results: [{
					id: "fetch-article",
					url: "https://example.com/article",
					content: "# Article body",
					extrasMeta: { title: "Example article" },
				}],
				statuses: [{ id: "fetch-article", status: "success" }],
				searchTime: 1,
			}), { status: 200 });
		};
		const { extractWithQuerit } = await import(${JSON.stringify(queritModuleUrl)});
		const result = await extractWithQuerit("https://example.com/article", undefined, { timeoutMs: 45_000 });
		console.log(JSON.stringify({ call, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			QUERIT_API_KEY: "synthetic-querit-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.call, {
		url: "https://api.querit.ai/v1/contents",
		body: {
			urls: ["https://example.com/article"],
			format: "markdown",
			crawlTimeout: 45,
			extrasMeta: true,
		},
	});
	assert.deepEqual(output.result, {
		url: "https://example.com/article",
		title: "Example article",
		content: "# Article body",
		error: null,
	});
});

test("Querit errors redact credentials and surface API-level failures", async () => {
	const home = await createHome();
	let child = runChild(
		`
		globalThis.fetch = async () => new Response("rejected synthetic-querit-secret", { status: 401 });
		const { searchWithQuerit } = await import(${JSON.stringify(queritModuleUrl)});
		let error = "";
		try { await searchWithQuerit("redact me"); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			QUERIT_API_KEY: "synthetic-querit-secret",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	let output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Querit Search API error 401/);
	assert.equal(output.error.includes("synthetic-querit-secret"), false);
	assert.match(output.error, /\[redacted\]/i);

	child = runChild(
		`
		globalThis.fetch = async () => new Response(JSON.stringify({ error_code: 429, error_msg: "quota exceeded", search_id: 301 }), { status: 200 });
		const { searchWithQuerit } = await import(${JSON.stringify(queritModuleUrl)});
		let error = "";
		try { await searchWithQuerit("quota"); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			QUERIT_API_KEY: "synthetic-querit-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	output = JSON.parse(child.stdout.trim());
	assert.equal(
		output.error,
		"Querit Search API returned error 429: quota exceeded",
	);
});

test("configured search routing can select Querit", async () => {
	const home = await createHome({
		searchRouting: { providers: ["querit"], fallbackOn: ["network"] },
	});
	const child = runChild(
		`
		globalThis.fetch = async () => new Response(JSON.stringify({
			error_code: 200,
			error_msg: "",
			search_id: 401,
			results: { result: [{ title: "Routed", url: "https://example.com/routed", snippet: "Querit route" }] },
		}), { status: 200 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, results: result.results }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: join(home, ".pi"),
			QUERIT_API_KEY: "synthetic-querit-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "querit");
	assert.equal(output.results[0].title, "Routed");
});

test("fetch_content uses Querit after local and earlier hosted extraction fail", async () => {
	const home = await createHome({
		fetchRouting: { allowRemoteHostedProviders: true },
	});
	const child = runChild(
		`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://example.com/app") {
				return new Response("<html><body><script></script><script></script><script></script><script></script>Loading</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			}
			if (target.startsWith("https://r.jina.ai/")) return new Response("", { status: 503 });
			if (target === "https://api.querit.ai/v1/contents") {
				return new Response(JSON.stringify({
					error_code: 200,
					error_msg: "",
					search_id: 402,
					results: [{ id: "fetch-app", url: "https://example.com/app", content: "# Querit rendered content", extrasMeta: { title: "Rendered" } }],
					statuses: [{ id: "fetch-app", status: "success" }],
					searchTime: 1,
				}), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target + " " + String(init.method || "GET"));
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const result = await extractContent("https://example.com/app", undefined, { lookup });
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			QUERIT_API_KEY: "synthetic-querit-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.com/app",
		"https://r.jina.ai/https://example.com/app",
		"https://api.querit.ai/v1/contents",
	]);
	assert.deepEqual(output.result, {
		url: "https://example.com/app",
		title: "Rendered",
		content: "# Querit rendered content",
		error: null,
	});
});

test("curator page exposes Querit as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["querit query"],
		"session-token",
		20,
		{
			all: false,
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: false,
			search1api: false,
			querit: true,
			tavily: false,
			serpdive: false,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: false,
			kimi: false,
			anysearch: false,
		},
		"querit",
		"querit",
		[],
		null,
	);
	assert.match(page, /data-provider="querit"/);
	assert.match(page, />Querit<\/button>/);
	assert.match(page, /provider-tag\.provider-querit/);
});

test("Querit provider timeout continues to the next fetch_content fallback", async () => {
	const home = await createHome({
		fetchRouting: { allowRemoteHostedProviders: true },
	});
	const child = runChild(
		`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			calls.push(target);
			if (target === "https://example.com/timeout") {
				return new Response("<html><body><script></script><script></script><script></script><script></script>Loading</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			}
			if (target.startsWith("https://r.jina.ai/")) return new Response("", { status: 503 });
			if (target === "https://api.querit.ai/v1/contents") {
				return new Promise((_resolve, reject) => {
					const keepAlive = setTimeout(() => reject(new Error("Querit timeout did not fire")), 100);
					const rejectAbort = () => {
						clearTimeout(keepAlive);
						reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
					};
					if (init.signal?.aborted) rejectAbort();
					else init.signal?.addEventListener("abort", rejectAbort, { once: true });
				});
			}
			if (target === "https://api.parallel.ai/v1/extract") {
				return new Response(JSON.stringify({
					results: [{
						url: "https://example.com/timeout",
						title: "Parallel fallback",
						full_content: "# Recovered by Parallel\\n" + "content ".repeat(100),
					}],
				}), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const result = await extractContent("https://example.com/timeout", undefined, { lookup, timeoutMs: 1 });
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			HOME: home,
			USERPROFILE: home,
			QUERIT_API_KEY: "synthetic-querit-test-key",
			PARALLEL_API_KEY: "synthetic-parallel-test-key",
		},
	);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.includes("https://api.querit.ai/v1/contents"));
	assert.ok(output.calls.includes("https://api.parallel.ai/v1/extract"));
	assert.equal(output.result.title, "Parallel fallback");
	assert.match(output.result.content, /Recovered by Parallel/);
});
