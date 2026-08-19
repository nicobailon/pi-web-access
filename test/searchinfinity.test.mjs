import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchinfinityModuleUrl = new URL("../searchinfinity.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

const PROVIDER_ENV_KEYS = [
	"OPENAI_API_KEY",
	"BRAVE_API_KEY",
	"PARALLEL_API_KEY",
	"TINYFISH_API_KEY",
	"SEARCH1API_KEY",
	"SEARCHINFINITY_API_KEY",
	"TAVILY_API_KEY",
	"JINA_API_KEY",
	"SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY",
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
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-searchinfinity-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config) + "\n", "utf8");
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

test("Searchinfinity availability reads environment and config credentials", async () => {
	const emptyHome = await createHome();
	let child = runChild(`
		const { isSearchinfinityAvailable } = await import(${JSON.stringify(searchinfinityModuleUrl)});
		console.log(String(isSearchinfinityAvailable()));
	`, { HOME: emptyHome, USERPROFILE: emptyHome });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	child = runChild(`
		const { isSearchinfinityAvailable } = await import(${JSON.stringify(searchinfinityModuleUrl)});
		console.log(String(isSearchinfinityAvailable()));
	`, { HOME: emptyHome, USERPROFILE: emptyHome, SEARCHINFINITY_API_KEY: "synthetic-searchinfinity-env-key" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const configHome = await createHome({ searchinfinityApiKey: "synthetic-searchinfinity-config-key" });
	child = runChild(`
		const { isSearchinfinityAvailable } = await import(${JSON.stringify(searchinfinityModuleUrl)});
		console.log(String(isSearchinfinityAvailable()));
	`, { HOME: configHome, USERPROFILE: configHome });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("explicit Searchinfinity search maps filters and prefers model summaries", async () => {
	const home = await createHome({ provider: "searchinfinity" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({
				url: String(url),
				headers: Object.fromEntries(new Headers(init.headers)),
				body: JSON.parse(init.body),
			});
			return new Response(JSON.stringify({
				ResponseMetadata: { RequestId: "req-1" },
				Result: {
					ResultCount: 1,
					WebResults: [{
						Id: "abc",
						SortId: 1,
						Title: "Searchinfinity Docs",
						Url: "https://www.byteplus.com/docs",
						Snippet: "  short   snippet ",
						Summary: "  Model   generated summary. ",
						PublishTime: "2026-07-30T00:00:00+08:00",
					}],
					SearchContext: { OriginQuery: "searchinfinity docs", SearchType: "web" },
					TimeCost: 100,
					LogId: "req-1",
				},
			}), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("searchinfinity docs", {
			provider: "searchinfinity",
			numResults: 1,
			recencyFilter: "week",
			domainFilter: ["https://www.byteplus.com/docs", "-example.com"],
		});
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, SEARCHINFINITY_API_KEY: "synthetic-searchinfinity-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [{
		url: "https://torchlight.byteintlapi.com/search_api/web_search",
		headers: {
			authorization: "Bearer synthetic-searchinfinity-test-key",
			"content-type": "application/json",
		},
		body: {
			Query: "searchinfinity docs",
			Count: 1,
			Filter: { Sites: "www.byteplus.com", BlockHosts: "example.com" },
			TimeRange: "OneWeek",
		},
	}]);
	assert.equal(output.result.provider, "searchinfinity");
	assert.deepEqual(output.result.results, [{
		title: "Searchinfinity Docs",
		url: "https://www.byteplus.com/docs",
		snippet: "Model generated summary.",
	}]);
});

test("Searchinfinity maps business error codes to HTTP semantics", async () => {
	const home = await createHome();
	const child = runChild(`
		const errors = [];
		globalThis.fetch = async (url, init) => {
			const body = JSON.parse(init.body);
			if (body.Query === "bad key") {
				return new Response(JSON.stringify({
					ResponseMetadata: { RequestId: "req-2a", Error: { CodeN: 700901, Code: "invalid_api_key", Message: "invalid api key" } },
					Result: null,
				}), { status: 200 });
			}
			return new Response(JSON.stringify({
				ResponseMetadata: { RequestId: "req-2b", Error: { CodeN: 700429, Code: "700429", Message: "QPS Exceeded" } },
				Result: null,
			}), { status: 200 });
		};
		const { searchWithSearchinfinity } = await import(${JSON.stringify(searchinfinityModuleUrl)});
		for (const query of ["bad key", "too fast"]) {
			try { await searchWithSearchinfinity(query); }
			catch (err) { errors.push(err.message); }
		}
		console.log(JSON.stringify({ errors }));
	`, { HOME: home, USERPROFILE: home, SEARCHINFINITY_API_KEY: "synthetic-searchinfinity-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.errors[0], /Searchinfinity Search API error 401/);
	assert.match(output.errors[0], /invalid api key/);
	assert.match(output.errors[0], /code 700901 invalid_api_key/);
	assert.match(output.errors[1], /Searchinfinity Search API error 429/);
	assert.match(output.errors[1], /QPS Exceeded/);
	assert.match(output.errors[1], /code 700429/);
});

test("Searchinfinity errors redact credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		globalThis.fetch = async () => new Response("rejected synthetic-searchinfinity-secret", { status: 401 });
		const { searchWithSearchinfinity } = await import(${JSON.stringify(searchinfinityModuleUrl)});
		let error = "";
		try { await searchWithSearchinfinity("redact me"); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`, { HOME: home, USERPROFILE: home, SEARCHINFINITY_API_KEY: "synthetic-searchinfinity-secret" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Searchinfinity Search API error 401/);
	assert.equal(output.error.includes("synthetic-searchinfinity-secret"), false);
	assert.match(output.error, /\[redacted\]/i);
});

test("configured searchRouting can select Searchinfinity", async () => {
	const home = await createHome({
		searchRouting: { providers: ["searchinfinity"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			ResponseMetadata: { RequestId: "req-3" },
			Result: {
				ResultCount: 1,
				WebResults: [{ Id: "x", SortId: 1, Title: "Routed", Snippet: "Searchinfinity route", Url: "https://example.com/routed" }],
				SearchContext: { OriginQuery: "route", SearchType: "web" },
				TimeCost: 10,
				LogId: "req-3",
			},
		}), { status: 200 });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, results: result.results }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi"), SEARCHINFINITY_API_KEY: "synthetic-searchinfinity-test-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "searchinfinity");
	assert.equal(output.results[0].title, "Routed");
});

test("curator page exposes Searchinfinity as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["searchinfinity query"],
		"session-token",
		20,
		{
			all: false,
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: false,
			search1api: false,
			searchinfinity: true,
			tavily: false,
			serpdive: false,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: false,
			kimi: false,
			anysearch: false,
		},
		"searchinfinity",
		"searchinfinity",
		[],
		null,
	);
	assert.match(page, /data-provider="searchinfinity"/);
	assert.match(page, />Searchinfinity<\/button>/);
	assert.match(page, /provider-tag\.provider-searchinfinity/);
});
