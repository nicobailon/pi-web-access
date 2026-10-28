import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const providers = [
	["anysearch", "anysearch", "searchWithAnySearch", "https://api.anysearch.com/v1/search", "Authorization"],
	["bocha", "bocha", "searchWithBocha", "https://api.bochaai.com/v1/web-search", "Authorization"],
	["brightdata", "brightdata", "searchWithBrightData", "https://api.brightdata.com/request", "Authorization"],
	["brightdata-unlocker", "brightdata", "extractWithBrightDataUnlocker", "https://api.brightdata.com/request", "Authorization"],
	["ceramic", "ceramic", "searchWithCeramic", "https://api.ceramic.ai/search", "Authorization"],
	["deepseek", "deepseek", "searchWithDeepSeek", "https://api.deepseek.com/v1/tools/search", "Authorization",
		["extractWithDeepSeek", "https://api.deepseek.com/v1/tools/fetch"]],
	["jina-search", "jinaSearch", "searchWithJina", "https://s.jina.ai/gateway%20query", "Authorization"],
	["kagi", "kagi", "searchWithKagi", "https://kagi.com/api/v1/search", "Authorization",
		["extractWithKagi", "https://kagi.com/api/v1/extract"]],
	["keenable", "keenable", "searchWithKeenable", "https://api.keenable.ai/v1/search", "X-API-Key"],
	["linkup", "linkup", "searchWithLinkup", "https://api.linkup.so/v1/search", "Authorization"],
	["mistral-search", "mistralSearch", "searchWithMistral", "https://api.mistral.ai/v1/conversations", "Authorization"],
	["ollama", "ollama", "searchWithOllama", "https://ollama.com/api/web_search", "Authorization",
		["extractWithOllama", "https://ollama.com/api/web_fetch"]],
	["perplexity", "perplexity", "searchWithPerplexity", "https://api.perplexity.ai/search", "Authorization",
		["askPerplexity", "https://api.perplexity.ai/chat/completions"]],
	["querit", "querit", "searchWithQuerit", "https://api.querit.ai/v1/search", "Authorization",
		["extractWithQuerit", "https://api.querit.ai/v1/contents"]],
	["search1api", "search1api", "searchWithSearch1API", "https://api.search1api.com/search", "Authorization",
		["extractWithSearch1API", "https://api.search1api.com/crawl"]],
	["searchapi", "searchapi", "searchWithSearchApi", "https://www.searchapi.io/api/v1/search", "Authorization"],
	["searchinfinity", "searchinfinity", "searchWithSearchinfinity", "https://torchlight.byteintlapi.com/search_api/web_search", "Authorization"],
	["serpbase", "serpbase", "searchWithSerpBase", "https://api.serpbase.dev/google/search", null],
	["serpdive", "serpdive", "searchWithSerpdive", "https://api.serpdive.com/v1/search", "Authorization"],
	["serply", "serply", "searchWithSerply", "https://api.serply.io/v1/search", "X-Api-Key"],
	["tabstack", "tabstack", "searchWithTabstack", "https://api.tabstack.ai/v1/research", "Authorization",
		["extractWithTabstack", "https://api.tabstack.ai/v1/extract/markdown"]],
	["valyu", "valyu", "searchWithValyu", "https://api.valyu.ai/v1/search", "x-api-key"],
	["xcrawl", "xcrawl", "searchWithXCrawl", "https://run.xcrawl.com/v1/serp", "Authorization"],
	["you", "you", "searchWithYou", "https://ydc-index.io/v1/search", "X-API-Key"],
].map(([file, stem, name, url, header, extra]) => ({
	file, stem, header, methods: [[name, url], ...(extra ? [extra] : [])],
	envKey: (["ollama", "deepseek", "tabstack"].includes(stem) ? "PI_" : "")
		+ stem.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() + "_BASE_URL",
}));

async function runFixture(t, provider, script, config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-gateway-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const credential = ({ jinaSearch: "jina", mistralSearch: "mistral" })[provider.stem] ?? provider.stem;
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		[credential + "ApiKey"]: "gateway-test-key",
		brightdataSerpZone: "serp_zone",
		brightdataUnlockerZone: "unlocker_zone",
		...config,
	}));
	const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home };
	delete env.XDG_CONFIG_HOME;
	for (const key of Object.keys(env)) {
		if (/_BASE_URL$|_API_KEY$/.test(key)) delete env[key];
	}
	const moduleUrl = new URL(`../${provider.file}.ts`, import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import assert from "node:assert/strict";
			const provider = ${JSON.stringify(provider)};
			const envKey = provider.envKey;
			const module = await import(${JSON.stringify(moduleUrl)});
			const options = { lookup: async () => [{address: "93.184.216.34", family: 4}] };
			const invoke = name => name.startsWith("extract")
				? module[name]("https://example.com/page", undefined, options)
				: module[name]("gateway query", {numResults: 1});
			const calls = [];
			const capture = (url, init) => {
				const target = new URL(url);
				calls.push({
					origin: target.origin,
					path: target.pathname,
					query: Object.fromEntries(target.searchParams),
					credential: provider.header ? new Headers(init.headers).get(provider.header) : target.searchParams.get("api_key"),
					method: init.method ?? "GET",
					body: init.body,
					signal: init.signal,
				});
			};
			globalThis.fetch = async (url, init) => {
				capture(url, init);
				throw new Error("OFFLINE_REQUEST_CAPTURED");
			};
			const request = async name => {
				await assert.rejects(() => invoke(name), /OFFLINE_REQUEST_CAPTURED/);
			};
			${script}
		`,
		env,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr || child.stdout);
}

for (const file of ["kagi", "ollama", "brightdata-unlocker"]) {
	const provider = providers.find(provider => provider.file === file);
	for (const blocked of ["target", "api", "redirect"]) {
		test(`${file}: gateway overrides preserve ${blocked} SSRF checks`, async (t) => {
			await runFixture(t, provider, `
				options.lookup = async hostname => [{
					address: hostname === ${JSON.stringify({ target: "example.com", api: "gateway.example.com", redirect: "blocked.example.com" }[blocked])}
						? "127.0.0.1" : "93.184.216.34",
					family: 4,
				}];
				globalThis.fetch = async (url, init) => {
					capture(url, init);
					return new Response(null, {status: 307, headers: {location: "https://blocked.example.com/private"}});
				};
				const [name] = provider.methods.find(([name]) => name.startsWith("extract"));
				await assert.rejects(() => invoke(name), /Blocked internal/);
				assert.equal(calls.length, ${blocked === "redirect" ? 1 : 0});
			`, { [provider.stem + "BaseUrl"]: `https://gateway.example.com/proxy/${provider.stem}` });
		});
	}
}

test("Jina dot queries cannot escape the configured gateway prefix", async (t) => {
	const provider = providers.find(provider => provider.file === "jina-search");
	await runFixture(t, provider, `
		for (const query of [".", ".."]) {
			await assert.rejects(() => module.searchWithJina(query), /Jina Search query must not be a dot path segment/);
		}
		assert.equal(calls.length, 0);
	`, { jinaSearchBaseUrl: "https://gateway.example.com/proxy/jina" });
});

for (const file of ["ollama", "deepseek", "tabstack"]) {
	test(`${file}: the bare ${file.toUpperCase()}_BASE_URL used by other tools leaves the official endpoint`, async (t) => {
		const provider = providers.find(provider => provider.file === file);
		await runFixture(t, provider, `
			process.env[${JSON.stringify(file.toUpperCase() + "_BASE_URL")}] = "http://localhost:11434/v1";
			for (const [name, endpoint] of provider.methods) {
				await request(name);
				assert.equal(calls.at(-1).origin + calls.at(-1).path, new URL(endpoint).origin + new URL(endpoint).pathname);
			}
		`);
	});
}

test("Keenable's public endpoint uses the same override without adding authentication", async (t) => {
	const provider = providers.find(provider => provider.file === "keenable");
	await runFixture(t, provider, `
		await request("searchWithKeenable");
		assert.equal(calls[0].path, "/proxy/keenable/v1/search/public");
		assert.equal(calls[0].credential, null);
	`, { keenableApiKey: "", keenableBaseUrl: "https://gateway.example.com/proxy/keenable" });
});

for (const provider of providers) {
	test(`${provider.file}: official endpoints remain unchanged`, async (t) => {
		await runFixture(t, provider, `
			for (const [name, endpoint] of provider.methods) {
				await request(name);
				const expected = new URL(endpoint), call = calls.at(-1);
				assert.equal(call.origin, expected.origin);
				assert.equal(call.path, expected.pathname);
				assert.ok(call.credential.endsWith("gateway-test-key"));
			}
		`);
	});

	test(`${provider.file}: gateway prefixes and environment precedence cover every operation`, async (t) => {
		await runFixture(t, provider, `
			for (const origin of ["https://gateway.example.com", "https://env.example.com"]) {
				if (origin.includes("env.")) process.env[envKey] = origin + "/proxy/" + provider.stem + "///";
				for (const [name, endpoint] of provider.methods) {
					await request(name);
					const call = calls.at(-1);
					assert.equal(call.origin, origin);
					assert.equal(call.path, "/proxy/" + provider.stem + new URL(endpoint).pathname);
					assert.ok(call.credential.endsWith("gateway-test-key"));
				}
			}
		`, { [provider.stem + "BaseUrl"]: `https://gateway.example.com/proxy/${provider.stem}///` });
	});

	test(`${provider.file}: invalid overrides never reach the network or the official host`, async (t) => {
		await runFixture(t, provider, `
			for (const value of ["", "not-a-url", "http://gateway.example.com", "https://user:secret@gateway.example.com", "https://gateway.example.com?debug=true", "https://gateway.example.com#fragment"]) {
				process.env[envKey] = value;
				for (const [name] of provider.methods) await assert.rejects(() => invoke(name), new RegExp(envKey));
			}
			delete process.env[envKey];
			for (const [name] of provider.methods) await assert.rejects(() => invoke(name), new RegExp(provider.stem + "BaseUrl"));
			assert.equal(calls.length, 0);
		`, { [provider.stem + "BaseUrl"]: "https://user:secret@gateway.example.com" });
	});

	test(`${provider.file}: cross-origin redirects strip authentication without changing payloads`, async (t) => {
		await runFixture(t, provider, `
			globalThis.fetch = async (url, init) => {
				capture(url, init);
				if (calls.length % 2) {
					const next = new URL(url);
					next.hostname = "other.example.com";
					return new Response(null, {status: 307, headers: {location: next.href}});
				}
				throw new Error("OFFLINE_REQUEST_CAPTURED");
			};
			for (const [name] of provider.methods) {
				await request(name);
				const [first, last] = calls.slice(-2);
				assert.ok(first.credential.endsWith("gateway-test-key"));
				assert.equal(last.credential, null);
				assert.equal(last.method, first.method);
				assert.equal(last.body, first.body);
				assert.equal(last.signal, first.signal);
			}
		`, { [provider.stem + "BaseUrl"]: `https://gateway.example.com/proxy/${provider.stem}` });
	});
}
