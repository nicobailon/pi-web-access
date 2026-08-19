import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const jinaModuleUrl = new URL("../jina-search.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const activityModuleUrl = new URL("../activity.ts", import.meta.url).href;
const readmeUrl = new URL("../README.md", import.meta.url);

const PROVIDER_ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"XDG_CONFIG_HOME",
	"OPENAI_API_KEY",
	"BRAVE_API_KEY",
	"PARALLEL_API_KEY",
	"TINYFISH_API_KEY",
	"SEARCH1API_KEY",
	"SEARCHINFINITY_API_KEY",
	"QUERIT_API_KEY",
	"TAVILY_API_KEY",
	"JINA_API_KEY",
	"SERPDIVE_API_KEY",
	"KAGI_API_KEY",
	"OLLAMA_API_KEY",
	"SERPBASE_API_KEY",
	"ANYSEARCH_API_KEY",
	"XAI_API_KEY",
	"BRIGHTDATA_API_KEY",
	"SEARXNG_BASE_URL",
	"EXA_API_KEY",
	"PERPLEXITY_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"CLOUDFLARE_API_KEY",
];

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-jina-search-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of PROVIDER_ENV_KEYS) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
		timeout: 15_000,
	});
}

test("Jina Search availability reads environment and config credentials", async () => {
	const emptyHome = await createHome();
	let child = runChild(`
		const { isJinaSearchAvailable } = await import(${JSON.stringify(jinaModuleUrl)});
		console.log(String(isJinaSearchAvailable()));
	`, { HOME: emptyHome, USERPROFILE: emptyHome });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	child = runChild(`
		const { isJinaSearchAvailable } = await import(${JSON.stringify(jinaModuleUrl)});
		console.log(String(isJinaSearchAvailable()));
	`, { HOME: emptyHome, USERPROFILE: emptyHome, JINA_API_KEY: "synthetic-jina-env-key" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const configHome = await createHome({ jinaApiKey: "synthetic-jina-config-key" });
	child = runChild(`
		const { isJinaSearchAvailable } = await import(${JSON.stringify(jinaModuleUrl)});
		console.log(String(isJinaSearchAvailable()));
	`, { HOME: configHome, USERPROFILE: configHome });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("Jina Search resolves command credentials only when a request starts", async () => {
	const markerDir = await mkdtemp(join(tmpdir(), "pi-web-access-jina-marker-"));
	const marker = join(markerDir, "ran");
	const home = await createHome({
		jinaApiKey: `!touch ${marker} && printf synthetic-jina-command-key`,
	});
	const child = runChild(`
		import { existsSync } from "node:fs";
		const { isJinaSearchAvailable, searchWithJina } = await import(${JSON.stringify(jinaModuleUrl)});
		const availableBefore = isJinaSearchAvailable();
		const ranBefore = existsSync(${JSON.stringify(marker)});
		let authorization = "";
		globalThis.fetch = async (_url, init) => {
			authorization = new Headers(init.headers).get("authorization") || "";
			return new Response(JSON.stringify({ code: 200, status: 20000, data: [] }), { status: 200 });
		};
		await searchWithJina("credential timing");
		console.log(JSON.stringify({ availableBefore, ranBefore, ranAfter: existsSync(${JSON.stringify(marker)}), authorization }));
	`, { HOME: home, USERPROFILE: home });

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		availableBefore: true,
		ranBefore: false,
		ranAfter: true,
		authorization: "Bearer synthetic-jina-command-key",
	});
	assert.equal(existsSync(marker), true);
});

test("explicit Jina search maps filters, full content, unique results, and truthful headers", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init = {}) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)) };
			return new Response(JSON.stringify({
				code: 200,
				status: 20000,
				data: [
					{ title: "Jina Docs", url: "https://docs.jina.ai/search", description: "  Search   docs. ", content: "# Full Jina docs" },
					{ title: "Duplicate", url: "https://docs.jina.ai/search", description: "duplicate", content: "duplicate" },
					{ title: "Jina Reader", url: "https://jina.ai/reader", description: "Reader docs", content: "# Reader docs" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("jina search docs", {
			provider: "jina",
			includeContent: true,
			numResults: 2,
			recencyFilter: "week",
			domainFilter: ["https://docs.jina.ai/search", "-reddit.com"],
		});
		console.log(JSON.stringify({ captured, result }));
	`, { HOME: home, USERPROFILE: home, JINA_API_KEY: "synthetic-jina-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	const requestUrl = new URL(output.captured.url);
	assert.equal(requestUrl.origin, "https://s.jina.ai");
	assert.equal(decodeURIComponent(requestUrl.pathname.slice(1)), "jina search docs -site:reddit.com published in the past week");
	assert.deepEqual(requestUrl.searchParams.getAll("site"), ["docs.jina.ai"]);
	assert.equal(requestUrl.searchParams.get("count"), "2");
	assert.equal(output.captured.headers.authorization, "Bearer synthetic-jina-test-key");
	assert.equal(output.captured.headers.accept, "application/json");
	assert.equal(output.captured.headers["user-agent"], "pi-web-access");
	assert.equal(output.captured.headers["x-respond-with"], "content");
	assert.equal(output.captured.headers["x-retain-images"], "none");
	assert.equal(output.result.provider, "jina");
	assert.deepEqual(output.result.results, [
		{ title: "Jina Docs", url: "https://docs.jina.ai/search", snippet: "Search docs." },
	]);
	assert.deepEqual(output.result.inlineContent, [
		{ url: "https://docs.jina.ai/search", title: "Jina Docs", content: "# Full Jina docs", error: null },
	]);
	assert.match(output.result.answer, /Search docs\./);
	assert.match(output.result.answer, /https:\/\/docs\.jina\.ai\/search/);
});

test("Jina Search skips page crawling without includeContent and accepts the direct array response", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init = {}) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)) };
			return new Response(JSON.stringify([
				{ title: "Result", url: "https://example.com/result", description: "Result snippet", content: "must stay hidden" },
			]), { status: 200 });
		};
		const { searchWithJina } = await import(${JSON.stringify(jinaModuleUrl)});
		const result = await searchWithJina("basic search", { numResults: 99 });
		console.log(JSON.stringify({ captured, result }));
	`, { HOME: home, USERPROFILE: home, JINA_API_KEY: "synthetic-jina-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(new URL(output.captured.url).searchParams.get("count"), "20");
	assert.equal(output.captured.headers["x-respond-with"], "no-content");
	assert.equal("inlineContent" in output.result, false);
	assert.deepEqual(output.result.results, [{ title: "Result", url: "https://example.com/result", snippet: "Result snippet" }]);
});

test("Jina Search errors redact credentials and retain an HTTP-classifiable status", async () => {
	const home = await createHome();
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ detail: "rejected synthetic-jina-secret" }), { status: 401 });
		const { searchWithJina } = await import(${JSON.stringify(jinaModuleUrl)});
		let error = "";
		try { await searchWithJina("redact me"); }
		catch (err) { error = String(err); }
		console.log(JSON.stringify({ error }));
	`, { HOME: home, USERPROFILE: home, JINA_API_KEY: "synthetic-jina-secret" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Jina Search API error 401/);
	assert.equal(output.error.includes("synthetic-jina-secret"), false);
	assert.match(output.error, /\[redacted\]/i);
});

test("Jina Search invalid JSON errors do not include response body credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		globalThis.fetch = async () => new Response("synthetic-jina-secret malformed", { status: 200 });
		const { searchWithJina } = await import(${JSON.stringify(jinaModuleUrl)});
		let error = "";
		try { await searchWithJina("invalid json"); }
		catch (err) { error = String(err); }
		console.log(JSON.stringify({ error }));
	`, { HOME: home, USERPROFILE: home, JINA_API_KEY: "synthetic-jina-secret" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.error, "Error: Jina Search API returned invalid JSON");
	assert.equal(output.error.includes("synthetic-jina-secret"), false);
});

test("configured routing treats Jina's own timeout as transient rather than caller cancellation", async () => {
	const home = await createHome({
		searchRouting: { providers: ["jina", "tavily"], fallbackOn: ["transient"] },
	});
	const child = runChild(`
		const originalTimeout = AbortSignal.timeout;
		AbortSignal.timeout = () => AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://s.jina.ai/")) {
				AbortSignal.timeout = originalTimeout;
				throw init.signal.reason;
			}
			if (target === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "Tavily fallback", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("timeout route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: join(home, ".pi"),
		JINA_API_KEY: "synthetic-jina-test-key",
		TAVILY_API_KEY: "synthetic-tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.calls.length, 2);
});

test("configured routing treats a Jina response-body timeout as transient", async () => {
	const home = await createHome({
		searchRouting: { providers: ["jina", "tavily"], fallbackOn: ["transient"] },
	});
	const child = runChild(`
		const originalTimeout = AbortSignal.timeout;
		AbortSignal.timeout = () => AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://s.jina.ai/")) {
				return {
					ok: true,
					status: 200,
					async json() {
						AbortSignal.timeout = originalTimeout;
						throw init.signal.reason;
					},
				};
			}
			if (target === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "Tavily body-timeout fallback", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("body timeout route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: join(home, ".pi"),
		JINA_API_KEY: "synthetic-jina-test-key",
		TAVILY_API_KEY: "synthetic-tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.calls.length, 2);
});

test("Jina envelope failures are recorded as activity errors", async () => {
	const home = await createHome();
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			code: 429,
			message: "quota exhausted",
			data: [],
		}), { status: 200, headers: { "Content-Type": "application/json" } });
		const [{ searchWithJina }, { activityMonitor }] = await Promise.all([
			import(${JSON.stringify(jinaModuleUrl)}),
			import(${JSON.stringify(activityModuleUrl)}),
		]);
		try { await searchWithJina("activity envelope failure"); } catch {}
		console.log(JSON.stringify(activityMonitor.getEntries().at(-1)));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: join(home, ".pi"),
		JINA_API_KEY: "synthetic-jina-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const entry = JSON.parse(child.stdout.trim());
	assert.equal(entry.status, null);
	assert.match(entry.error, /Jina Search API error 429/);
});

test("configured routing preserves Jina envelope status codes", async () => {
	const home = await createHome({
		searchRouting: { providers: ["jina", "tavily"], fallbackOn: ["quota"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://s.jina.ai/")) {
				return new Response(JSON.stringify({ code: 429, status: 42901, data: [] }), { status: 200 });
			}
			if (target === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ answer: "Tavily quota fallback", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("quota route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: join(home, ".pi"),
		JINA_API_KEY: "synthetic-jina-test-key",
		TAVILY_API_KEY: "synthetic-tavily-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "tavily");
	assert.equal(output.calls.length, 2);
});

test("configured searchRouting can select Jina Search", async () => {
	const home = await createHome({
		searchRouting: { providers: ["jina"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			code: 200,
			status: 20000,
			data: [{ title: "Routed", description: "Jina route", url: "https://example.com/routed" }],
		}), { status: 200 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, results: result.results }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi"), JINA_API_KEY: "synthetic-jina-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "jina");
	assert.equal(output.results[0].title, "Routed");
});

test('provider "all" includes configured Jina Search alongside zero-config Exa', async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith("https://mcp.exa.ai/mcp")) {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: { content: [{ type: "text", text: "Title: Exa result\\nURL: https://example.com/exa\\nText: Exa answer\\n---" }] },
				}), { status: 200 });
			}
			if (target.startsWith("https://s.jina.ai/")) {
				return new Response(JSON.stringify({ code: 200, status: 20000, data: [
					{ title: "Jina result", url: "https://example.com/jina", description: "Jina answer" },
				] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("combined", { provider: "all" });
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, JINA_API_KEY: "synthetic-jina-test-key" });

	assert.equal(child.status, 0, child.stderr || child.error?.message);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.some((url) => url.startsWith("https://s.jina.ai/")));
	assert.deepEqual(output.result.providerResponses.map((result) => result.provider), ["exa", "jina"]);
	assert.deepEqual(output.result.results.map((result) => result.url), ["https://example.com/exa", "https://example.com/jina"]);
	assert.match(output.result.answer, /## Jina/);
});

test("curator page exposes Jina Search as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["jina query"],
		"session-token",
		20,
		{
			all: false,
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: false,
			search1api: false,
			searchinfinity: false,
			querit: false,
			tavily: false,
			jina: true,
			serpdive: false,
			kagi: false,
			ollama: false,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: false,
			kimi: false,
			anysearch: false,
			xai: false,
			brightdata: false,
			serpbase: false,
		},
		"jina",
		"jina",
		[],
		null,
	);
	assert.match(page, /data-provider="jina"/);
	assert.match(page, />Jina<\/button>/);
	assert.match(page, /provider-tag\.provider-jina/);
});

test("README documents Jina Search credentials and routing", async () => {
	const readme = await readFile(readmeUrl, "utf8");
	assert.match(readme, /JINA_API_KEY/);
	assert.match(readme, /jinaApiKey/);
	assert.match(readme, /`jina`/);
	assert.match(readme, /s\.jina\.ai/);
});
