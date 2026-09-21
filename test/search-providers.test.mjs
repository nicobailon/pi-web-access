import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;
const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;
const openaiModuleUrl = new URL("../openai-search.ts", import.meta.url).href;
const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;
const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;
const searxngModuleUrl = new URL("../searxng.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const indexModuleUrl = new URL("../index.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"BRAVE_BASE_URL",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"SEARCH1API_KEY",
		"SEARCHINFINITY_API_KEY",
		"QUERIT_API_KEY",
		"TAVILY_API_KEY",
		"TAVILY_BASE_URL",
		"FIRECRAWL_BASE_URL",
		"FIRECRAWL_API_KEY",
		"JINA_API_KEY",
		"SEARXNG_BASE_URL",
		"EXA_API_KEY",
		"EXA_BASE_URL",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Brave search applies domain filters in the query and returned results", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				web: { results: [
					{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", description: "repo" },
					{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", description: "gist" },
					{ title: "Example", url: "https://example.com/nope", description: "example" },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await searchWithBrave("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 2,
		});
		const parsedUrl = new URL(capturedUrl);
		console.log(JSON.stringify({
			q: parsedUrl.searchParams.get("q"),
			count: parsedUrl.searchParams.get("count"),
			token: capturedHeaders["X-Subscription-Token"],
			results: result.results,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /NOT site:gist\.github\.com/);
	assert.equal(output.count, "20");
	assert.equal(output.token, "brave-test-key");
	assert.deepEqual(output.results.map((result) => result.url), ["https://github.com/nicobailon/pi-web-access"]);
});

test("Perplexity normalizes invalid result counts", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-perplexity-count-"));
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			choices: [{ message: { content: "answer" } }],
			citations: ["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://example.com/d", "https://example.com/e"],
		}), { status: 200, headers: { "content-type": "application/json" } });

		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModuleUrl)});
		const negative = await searchWithPerplexity("negative", { numResults: -1 });
		const nan = await searchWithPerplexity("nan", { numResults: Number.NaN });
		const decimal = await searchWithPerplexity("decimal", { numResults: 3.8 });
		console.log(JSON.stringify({ counts: [negative.results.length, nan.results.length, decimal.results.length] }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PERPLEXITY_API_KEY: "pplx-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()).counts, [1, 5, 3]);
});

test("Perplexity retains cited sources beyond numResults", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-perplexity-citations-"));
	const child = runChild(`
		globalThis.fetch = async (_url, init) => {
			const query = JSON.parse(init.body).messages[0].content;
			const answer = query === "cited" ? "The answer cites [13]." : "The answer has no citations.";
			return new Response(JSON.stringify({
				choices: [{ message: { content: answer } }],
				citations: Array.from({ length: 13 }, (_, index) => "https://example.com/source-" + (index + 1)),
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModuleUrl)});
		const cited = await searchWithPerplexity("cited", { numResults: 8 });
		const uncited = await searchWithPerplexity("uncited", { numResults: 8 });
		console.log(JSON.stringify({ cited: cited.results, uncitedCount: uncited.results.length }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PERPLEXITY_API_KEY: "pplx-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.cited.length, 13);
	assert.deepEqual(output.cited[12], {
		title: "Source 13",
		url: "https://example.com/source-13",
		snippet: "",
	});
	assert.equal(output.uncitedCount, 8);
});

test("Tavily search uses bearer auth and maps filters/content", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "Tavily answer",
				results: [{
					title: "Tavily Docs",
					url: "https://docs.tavily.com/search",
					content: "Search docs snippet",
					raw_content: "# Tavily Docs\\nFull content",
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		const result = await searchWithTavily("tavily search docs", {
			domainFilter: ["https://docs.tavily.com/search", "-reddit.com"],
			recencyFilter: "week",
			numResults: 4,
			includeContent: true,
		});
		console.log(JSON.stringify({ capturedUrl, capturedHeaders, capturedBody, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		TAVILY_API_KEY: "tvly-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://api.tavily.com/search");
	assert.equal(output.capturedHeaders.Authorization, "Bearer tvly-test-key");
	assert.deepEqual(output.capturedBody, {
		query: "tavily search docs",
		search_depth: "basic",
		max_results: 4,
		include_answer: "basic",
		include_raw_content: "markdown",
		time_range: "week",
		include_domains: ["docs.tavily.com"],
		exclude_domains: ["reddit.com"],
	});
	assert.equal(output.result.answer, "Tavily answer");
	assert.deepEqual(output.result.results, [{ title: "Tavily Docs", url: "https://docs.tavily.com/search", snippet: "Search docs snippet" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://docs.tavily.com/search", title: "Tavily Docs", content: "# Tavily Docs\nFull content", error: null }]);
});

test("Brave, keyed Exa, and Tavily honor base URL overrides without leaking credentials across origins", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-provider-base-url-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		braveApiKey: "brave-config-key",
		braveBaseUrl: "https://gateway.example.com/brave/res/v1/",
		exaApiKey: "exa-config-key",
		exaBaseUrl: "https://gateway.example.com/exa/",
		tavilyApiKey: "tavily-config-key",
		tavilyBaseUrl: "https://gateway.example.com/tavily/",
	}) + "\n");

	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			const headers = new Headers(init.headers);
			calls.push({
				target,
				credential: headers.get("x-subscription-token") ?? headers.get("x-api-key") ?? headers.get("authorization"),
				redirect: init.redirect,
				method: init.method,
				hasBody: init.body !== undefined,
				contentType: headers.get("content-type"),
			});
			if (target.startsWith("https://gateway.example.com/")) {
				return new Response(null, {
					status: target.includes("/tavily/") ? 302 : 307,
					headers: { location: target.replace("gateway.example.com", "redirect.example.com") },
				});
			}
			if (target.includes("/brave/res/v1/web/search?")) {
				return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
			}
			if (target.endsWith("/exa/answer")) {
				return new Response(JSON.stringify({ answer: "answer", citations: [] }), { status: 200 });
			}
			if (target.endsWith("/exa/search")) {
				return new Response(JSON.stringify({ results: [] }), { status: 200 });
			}
			if (target.endsWith("/tavily/search")) {
				return new Response(JSON.stringify({ answer: "answer", results: [] }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const { searchWithTavily } = await import(${JSON.stringify(tavilyModuleUrl)});
		await searchWithBrave("configured");
		await searchWithExa("answer endpoint");
		await searchWithExa("search endpoint", { numResults: 2 });
		await searchWithTavily("configured");

		process.env.BRAVE_BASE_URL = "https://env.example.com/brave/res/v1/";
		process.env.EXA_BASE_URL = "https://env.example.com/exa/";
		process.env.TAVILY_BASE_URL = "https://env.example.com/tavily/";
		await searchWithBrave("environment");
		await searchWithExa("environment");
		await searchWithTavily("environment");

		process.env.BRAVE_BASE_URL = "not-a-url";
		let invalidError = "";
		try {
			await searchWithBrave("invalid");
		} catch (error) {
			invalidError = error.message;
		}
		process.env.BRAVE_BASE_URL = "http://gateway.example.com/brave/res/v1";
		let plaintextError = "";
		try {
			await searchWithBrave("plaintext");
		} catch (error) {
			plaintextError = error.message;
		}
		console.log(JSON.stringify({ calls, invalidError, plaintextError }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls.map((call) => call.target), [
		"https://gateway.example.com/brave/res/v1/web/search?q=configured&count=5",
		"https://redirect.example.com/brave/res/v1/web/search?q=configured&count=5",
		"https://gateway.example.com/exa/answer",
		"https://redirect.example.com/exa/answer",
		"https://gateway.example.com/exa/search",
		"https://redirect.example.com/exa/search",
		"https://gateway.example.com/tavily/search",
		"https://redirect.example.com/tavily/search",
		"https://env.example.com/brave/res/v1/web/search?q=environment&count=5",
		"https://env.example.com/exa/answer",
		"https://env.example.com/tavily/search",
	]);
	assert.deepEqual(output.calls.map((call) => call.credential), [
		"brave-config-key", null,
		"exa-config-key", null,
		"exa-config-key", null,
		"Bearer tavily-config-key", null,
		"brave-config-key", "exa-config-key", "Bearer tavily-config-key",
	]);
	assert.ok(output.calls.every((call) => call.redirect === "manual"));
	assert.deepEqual(output.calls.slice(6, 8).map(({ method, hasBody, contentType }) => ({ method, hasBody, contentType })), [
		{ method: "POST", hasBody: true, contentType: "application/json" },
		{ method: "GET", hasBody: false, contentType: null },
	]);
	assert.match(output.invalidError, /^BRAVE_BASE_URL must be an absolute HTTP\(S\) URL$/);
	assert.match(output.plaintextError, /^BRAVE_BASE_URL must be an absolute HTTPS URL$/);
});

test("provider base URLs allow HTTP only on exact loopback hosts", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-loopback-base-url-"));
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const target = String(url);
			const credential = new Headers(init.headers).get("x-subscription-token");
			calls.push({ target, credential });
			if (new URL(target).searchParams.get("q") === "redirect") {
				return new Response(null, {
					status: 307,
					headers: { location: "https://remote.example.com/redirected" },
				});
			}
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		process.env.BRAVE_BASE_URL = "http://localhost:8080/api";
		await searchWithBrave("redirect");

		const accepted = [
			"http://localhost:8080/api/",
			"http://LOCALHOST:8080/api",
			"http://localhost.:8080/api",
			"http://127.0.0.1:8080/api",
			"http://127.42.3.4:8080/api",
			"http://[::1]:8080/api",
			"http://[0:0:0:0:0:0:0:1]:8080/api",
			"https://gateway.example.com/api",
		];
		for (const [index, baseUrl] of accepted.entries()) {
			process.env.BRAVE_BASE_URL = baseUrl;
			await searchWithBrave("accepted-" + index);
		}

		const rejected = [
			"http://example.com/api",
			"http://localhost.example/api",
			"http://foo.localhost/api",
			"http://10.0.0.1/api",
			"http://169.254.169.254/api",
			"http://0.0.0.0/api",
			"http://[::]/api",
			"http://[::ffff:127.0.0.1]/api",
		];
		const rejectedErrors = [];
		for (const baseUrl of rejected) {
			process.env.BRAVE_BASE_URL = baseUrl;
			try {
				await searchWithBrave("rejected");
				rejectedErrors.push(null);
			} catch (error) {
				rejectedErrors.push(error.message);
			}
		}

		const invalid = [
			"http://user:secret@localhost:8080/api",
			"http://localhost:8080/api?debug=true",
			"http://localhost:8080/api#fragment",
		];
		const invalidErrors = [];
		for (const baseUrl of invalid) {
			process.env.BRAVE_BASE_URL = baseUrl;
			try {
				await searchWithBrave("invalid");
				invalidErrors.push(null);
			} catch (error) {
				invalidErrors.push(error.message);
			}
		}
		console.log(JSON.stringify({ calls, rejectedErrors, invalidErrors }));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-loopback-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls.slice(0, 2), [
		{ target: "http://localhost:8080/api/web/search?q=redirect&count=5", credential: "brave-loopback-key" },
		{ target: "https://remote.example.com/redirected", credential: null },
	]);
	assert.equal(output.calls.length, 10);
	assert.ok(output.calls.slice(2).every((call) => call.credential === "brave-loopback-key"));
	assert.deepEqual(output.rejectedErrors, Array(8).fill("BRAVE_BASE_URL must be an absolute HTTPS URL"));
	assert.deepEqual(output.invalidErrors, [
		"BRAVE_BASE_URL must not include credentials",
		"BRAVE_BASE_URL must not include query parameters or fragments",
		"BRAVE_BASE_URL must not include query parameters or fragments",
	]);
});

test("SearXNG search is SSRF-guarded and preferred first when configured", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-searxng-"));
	const child = runChild(`
		const { writeFileSync } = await import("node:fs");
		writeFileSync(${JSON.stringify(home)} + "/web-search.json", JSON.stringify({
			searxngBaseUrl: "http://127.0.0.1:8443/",
			ssrf: { allowRanges: ["127.0.0.1"] },
		}));
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), redirect: init.redirect });
			return new Response(JSON.stringify({
				answers: ["SearXNG answer"],
				results: [
					{ title: "Allowed", url: "https://docs.example.com/a", content: "allowed" },
					{ title: "Blocked", url: "https://private.example.net/b", content: "blocked" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const direct = await searchWithSearXNG("self hosted", { domainFilter: ["example.com", "-private.example.net"], numResults: 2 });
		const auto = await search("local first", { provider: "auto" });
		console.log(JSON.stringify({ calls, direct, auto }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	assert.equal(output.calls[0].url, "http://127.0.0.1:8443/search?q=self+hosted+site%3Aexample.com+-site%3Aprivate.example.net&format=json");
	assert.equal(output.calls[0].redirect, "manual");
	assert.deepEqual(output.direct.results, [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "allowed" }]);
	assert.equal(output.auto.provider, "searxng");
});

test("SearXNG search merges configured custom headers", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-searxng-headers-"));
	const child = runChild(`
		const { writeFileSync } = await import("node:fs");
		writeFileSync(${JSON.stringify(home)} + "/web-search.json", JSON.stringify({
			searxngBaseUrl: "http://127.0.0.1:8443/",
			searxngHeaders: {
				"CF-Access-Client-Id": "client-id.access",
				"CF-Access-Client-Secret": "client-secret",
				"X-Empty-Skip": 123,
				"X-Bad-Value": "bad\\r\\nvalue",
				"Bad Name": "nope",
			},
			ssrf: { allowRanges: ["127.0.0.1"] },
		}));
		let capturedHeaders = null;
		globalThis.fetch = async (_url, init = {}) => {
			capturedHeaders = init.headers ?? null;
			return new Response(JSON.stringify({
				results: [{ title: "Allowed", url: "https://docs.example.com/a", content: "allowed" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		await searchWithSearXNG("headers");
		console.log(JSON.stringify({ capturedHeaders }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.capturedHeaders, {
		Accept: "application/json",
		"CF-Access-Client-Id": "client-id.access",
		"CF-Access-Client-Secret": "client-secret",
	});

	const overrideHome = await mkdtemp(join(tmpdir(), "pi-web-access-searxng-headers-override-"));
	const overrideChild = runChild(`
		const { writeFileSync } = await import("node:fs");
		writeFileSync(${JSON.stringify(overrideHome)} + "/web-search.json", JSON.stringify({
			searxngBaseUrl: "http://127.0.0.1:8443/",
			searxngHeaders: { accept: "application/custom-json" },
			ssrf: { allowRanges: ["127.0.0.1"] },
		}));
		let capturedHeaders = null;
		globalThis.fetch = async (_url, init = {}) => {
			capturedHeaders = init.headers ?? null;
			return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		await searchWithSearXNG("headers");
		console.log(JSON.stringify({ capturedHeaders }));
	`, {
		HOME: overrideHome,
		USERPROFILE: overrideHome,
		PI_CODING_AGENT_DIR: overrideHome,
	});

	assert.equal(overrideChild.status, 0, overrideChild.stderr);
	assert.deepEqual(JSON.parse(overrideChild.stdout.trim()).capturedHeaders, { accept: "application/custom-json" });
});

test("SearXNG search strips configured headers on cross-origin redirects", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-searxng-headers-redirect-"));
	const child = runChild(`
		const { writeFileSync } = await import("node:fs");
		writeFileSync(${JSON.stringify(home)} + "/web-search.json", JSON.stringify({
			searxngBaseUrl: "http://127.0.0.1:8443/",
			searxngHeaders: {
				"CF-Access-Client-Id": "client-id.access",
				"CF-Access-Client-Secret": "client-secret",
			},
			ssrf: { allowRanges: ["127.0.0.1"] },
		}));
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: String(url), headers: init.headers ?? null });
			if (calls.length === 1) {
				return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8444/search" } });
			}
			return new Response(JSON.stringify({
				results: [{ title: "Allowed", url: "https://docs.example.com/a", content: "allowed" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		await searchWithSearXNG("headers redirect");
		console.log(JSON.stringify({ calls }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls[0].headers, {
		Accept: "application/json",
		"CF-Access-Client-Id": "client-id.access",
		"CF-Access-Client-Secret": "client-secret",
	});
	assert.deepEqual(output.calls[1].headers, { Accept: "application/json" });
});

test("SearXNG redirect validation rejects an unapproved private target", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-searxng-redirect-"));
	const child = runChild(`
		const { writeFileSync } = await import("node:fs");
		writeFileSync(${JSON.stringify(home)} + "/web-search.json", JSON.stringify({
			searxngBaseUrl: "http://127.0.0.1:8443/",
			ssrf: { allowRanges: ["127.0.0.1"] },
		}));
		globalThis.fetch = async () => new Response(null, {
			status: 302,
			headers: { location: "http://127.0.0.2:8443/search" },
		});
		const { searchWithSearXNG } = await import(${JSON.stringify(searxngModuleUrl)});
		try {
			await searchWithSearXNG("redirect");
			console.log(JSON.stringify({ ok: true }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error) }));
		}
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /Blocked internal address/);
});

test("malformed SearXNG SSRF config fails before hosted auto fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-searxng-config-"));
	const child = runChild(`
		const { writeFileSync } = await import("node:fs");
		writeFileSync(${JSON.stringify(home)} + "/web-search.json", JSON.stringify({
			searxngBaseUrl: "https://search.example.com",
			ssrf: { allowRanges: ["127.0.0.0/33"] },
		}));
		globalThis.fetch = async () => new Response(JSON.stringify({
			results: [{ title: "Hosted fallback", url: "https://example.com", content: "should not be used" }],
		}), { status: 200, headers: { "content-type": "application/json" } });
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("config", { provider: "auto" });
			console.log(JSON.stringify({ ok: true }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error) }));
		}
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		TAVILY_API_KEY: "tvly-hosted-fallback-must-not-run",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /Invalid CIDR notation in ssrf\.allowRanges/);
});

test("auto provider falls through to Tavily after unavailable earlier providers", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-auto-"));
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText.startsWith("https://mcp.exa.ai/mcp")) {
				return new Response("Exa unavailable", { status: 503 });
			}
			if (urlText === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({
					answer: "Auto Tavily answer",
					results: [{ title: "Tavily Auto", url: "https://docs.tavily.com/auto", content: "auto snippet" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("auto tavily docs", { provider: "auto" });
		console.log(JSON.stringify({ calls, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		TAVILY_API_KEY: "tvly-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.some((call) => call.startsWith("https://mcp.exa.ai/mcp")));
	assert.ok(output.calls.includes("https://api.tavily.com/search"));
	assert.equal(output.result.provider, "tavily");
	assert.equal(output.result.answer, "Auto Tavily answer");
});

test("Exa direct API key ignores full legacy usage counter", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-paid-"));
	const child = runChild(`
		const dir = ${JSON.stringify(home)};
		const { readFileSync, writeFileSync } = await import("node:fs");
		writeFileSync(dir + "/web-search.json", JSON.stringify({ exaApiKey: "exa-paid-key" }));
		writeFileSync(dir + "/exa-usage.json", JSON.stringify({ month: new Date().toISOString().slice(0, 7), count: 1000 }));

		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "Paid Exa answer",
				citations: [{ title: "Exa Docs", url: "https://exa.ai/docs" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { isExaAvailable, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = isExaAvailable();
		const result = await searchWithExa("paid exa query");
		const usage = JSON.parse(readFileSync(dir + "/exa-usage.json", "utf8"));
		console.log(JSON.stringify({
			available,
			capturedUrl,
			capturedBody,
			apiKey: capturedHeaders["x-api-key"],
			integration: capturedHeaders["x-exa-integration"],
			result,
			usage,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
	assert.equal(output.capturedUrl, "https://api.exa.ai/answer");
	assert.deepEqual(output.capturedBody, { query: "paid exa query" });
	assert.equal(output.apiKey, "exa-paid-key");
	assert.equal(output.integration, "pi-web-access");
	assert.equal(output.result.answer, "Paid Exa answer");
	assert.deepEqual(output.result.results, [{ title: "Exa Docs", url: "https://exa.ai/docs", snippet: "" }]);
	assert.equal(output.usage.count, 1000);
});

test("Exa command source is lazy, overrides stale env, and rotates per request", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-"));
	const commandPath = join(home, "read-key.sh");
	const counterPath = join(home, "counter");
	await writeFile(commandPath, `#!/bin/sh\ncount=0\n[ ! -f "$1" ] || count=$(cat "$1")\ncount=$((count + 1))\nprintf '%s' "$count" >"$1"\nprintf 'synthetic-exa-%s\\n' "$count"\n`, "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		exaApiKey: `!${commandPath} ${counterPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		import { existsSync } from "node:fs";
		const keys = [];
		globalThis.fetch = async (_url, init) => {
			keys.push(init.headers["x-api-key"]);
			return new Response(JSON.stringify({ answer: "ok", citations: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const { hasExaApiKey, searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const available = hasExaApiKey();
		const lazy = !existsSync(${JSON.stringify(counterPath)});
		await searchWithExa("first");
		await searchWithExa("second");
		console.log(JSON.stringify({ available, lazy, keys }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		available: true,
		lazy: true,
		keys: ["synthetic-exa-1", "synthetic-exa-2"],
	});
});

test("failed Exa command source is redacted and blocks MCP or provider fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-command-failure-"));
	const commandPath = join(home, "fail-key.sh");
	await writeFile(commandPath, "#!/bin/sh\nprintf 'SYNTHETIC_SECRET_MUST_NOT_ESCAPE\\n' >&2\nexit 9\n", "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		exaApiKey: `!${commandPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let message = "";
		try {
			await search("must fail closed", { provider: "auto" });
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify({ fetchCalls, message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: "stale-exa-environment-value",
		TAVILY_API_KEY: "stale-alternate-provider-value",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /^Exa credential resolution failed: command-failed$/);
	assert.equal(output.message.includes("SYNTHETIC_SECRET_MUST_NOT_ESCAPE"), false);
	assert.equal(output.message.includes(commandPath), false);
});

test("Exa provider errors redact the resolved credential", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-redaction-"));
	const secret = "SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE";
	const child = runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify("provider echoed SYNTHETIC_EXA_SECRET_MUST_NOT_ESCAPE")}, { status: 400 });
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		let message = "";
		try { await searchWithExa("redaction test"); }
		catch (error) { message = error.message; }
		console.log(JSON.stringify({ message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		EXA_API_KEY: secret,
	});
	assert.equal(child.status, 0, child.stderr);
	const { message } = JSON.parse(child.stdout.trim());
	assert.equal(message.includes(secret), false);
	assert.equal(message.includes("[redacted]"), true);
});

test("keyless Exa search sends filters to the advanced MCP tool as parameters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-mcp-advanced-"));
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: JSON.stringify({ results: [{
					title: "Advanced result",
					url: "https://docs.example.com/advanced",
					text: "full page text",
					highlights: ["relevant highlight"],
				}] }) }] },
			}), { status: 200 });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const result = await searchWithExa("semantic query", {
			numResults: 3,
			recencyFilter: "week",
			domainFilter: ["docs.example.com", "-spam.example.net"],
			includeContent: true,
		});
		console.log(JSON.stringify({ captured, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());
	assert.equal(captured.url, "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
	assert.equal(captured.body.params.name, "web_search_advanced_exa");

	const { startPublishedDate, ...args } = captured.body.params.arguments;
	assert.ok(startPublishedDate);
	assert.deepEqual(args, {
		query: "semantic query",
		type: "auto",
		numResults: 3,
		includeDomains: ["docs.example.com"],
		excludeDomains: ["spam.example.net"],
		enableHighlights: true,
		textMaxCharacters: 50000,
	});

	assert.deepEqual(result.results, [{ title: "Advanced result", url: "https://docs.example.com/advanced", snippet: "" }]);
	assert.match(result.answer, /relevant highlight/);
	assert.deepEqual(result.inlineContent, [{
		url: "https://docs.example.com/advanced",
		title: "Advanced result",
		content: "full page text",
		error: null,
	}]);
});

test("keyless Exa search falls back to the default MCP tool when the advanced tool is missing", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-mcp-fallback-"));
	const child = runChild(`
		const tools = [];
		globalThis.fetch = async (url, init) => {
			const target = String(url);
			tools.push(JSON.parse(init.body).params.name);
			if (target.includes("web_search_advanced_exa")) {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					error: { code: -32602, message: "Tool web_search_advanced_exa not found" },
				}), { status: 200 });
			}
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{
					type: "text",
					text: "Title: Basic result\\nURL: https://example.com/basic\\nText: basic text\\n---",
				}] },
			}), { status: 200 });
		};

		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		const result = await searchWithExa("fallback query", { domainFilter: ["example.com"] });
		console.log(JSON.stringify({ tools, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const { tools, result } = JSON.parse(child.stdout.trim());
	assert.deepEqual(tools, ["web_search_advanced_exa", "web_search_exa"]);
	assert.deepEqual(result.results, [{ title: "Basic result", url: "https://example.com/basic", snippet: "" }]);
});

test("failed Gemini command source is redacted and blocks browser fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-command-failure-"));
	const commandPath = join(home, "fail-key.sh");
	await writeFile(commandPath, "#!/bin/sh\nprintf 'SYNTHETIC_GEMINI_SECRET_MUST_NOT_ESCAPE\\n' >&2\nexit 9\n", "utf8");
	await chmod(commandPath, 0o700);
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		geminiApiKey: `!${commandPath}`,
	}) + "\n", "utf8");

	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; throw new Error("unexpected fetch"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let message = "";
		try {
			await search("must fail closed", { provider: "gemini" });
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify({ fetchCalls, message }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		GEMINI_API_KEY: "stale-gemini-environment-value",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /^Gemini credential resolution failed: command-failed$/);
	assert.equal(output.message.includes("SYNTHETIC_GEMINI_SECRET_MUST_NOT_ESCAPE"), false);
	assert.equal(output.message.includes(commandPath), false);
});

test("OpenAI search requires web_search and maps domain filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				output: [
					{
						type: "web_search_call",
						action: { sources: [{ title: "OpenAI Blog", url: "https://openai.com/blog?utm_source=openai" }] },
					},
					{
						type: "message",
						content: [{
							type: "output_text",
							text: "Answer from the web",
							annotations: [{
								type: "url_citation",
								start_index: 0,
								end_index: 6,
								url: "https://openai.com/docs?utm_source=openai",
								title: "OpenAI Docs",
							}],
						}],
					},
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("latest docs", {
			domainFilter: ["https://openai.com/docs", "-reddit.com"],
			numResults: 3,
		});
		console.log(JSON.stringify({
			url: capturedUrl,
			authorization: capturedHeaders.Authorization,
			body: capturedBody,
			results: result.results,
			answer: result.answer,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		OPENAI_API_KEY: "sk-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.url, "https://api.openai.com/v1/responses");
	assert.equal(output.authorization, "Bearer sk-test-key");
	assert.equal(output.body.tool_choice, "required");
	assert.deepEqual(output.body.include, ["web_search_call.action.sources"]);
	assert.deepEqual(output.body.tools[0].filters, {
		allowed_domains: ["openai.com"],
		blocked_domains: ["reddit.com"],
	});
	assert.equal(output.answer, "Answer from the web");
	assert.deepEqual(output.results.map((result) => result.url), [
		"https://openai.com/docs",
		"https://openai.com/blog",
	]);
});

test("OpenAI search uses configured Responses endpoint", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-url-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		openaiApiKey: "sk-config-key",
		openaiResponsesUrl: "https://gateway.example.com/v1/responses",
	}) + "\n");
	const child = runChild(`
		let capturedUrl = "";
		let capturedAuthorization = "";
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedAuthorization = init.headers.Authorization;
			return new Response(JSON.stringify({
				output: [
					{ type: "web_search_call", action: { sources: [] } },
					{ type: "message", content: [{ type: "output_text", text: "gateway answer" }] },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("gateway docs", { numResults: 1 });
		console.log(JSON.stringify({ capturedUrl, capturedAuthorization, answer: result.answer }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://gateway.example.com/v1/responses");
	assert.equal(output.capturedAuthorization, "Bearer sk-config-key");
	assert.equal(output.answer, "gateway answer");
});

test("curator auto default follows the active model provider", async () => {
	const { resolveCuratorDefaultProvider } = await import(indexModuleUrl);
	const available = {
		all: true,
		openai: true,
		brave: false,
		parallel: false,
		"parallel-mcp": false,
		tinyfish: false,
		search1api: false,
		searchinfinity: false,
		querit: false,
		tavily: false,
		firecrawl: false,
		jina: false,
		serpdive: false,
		searxng: false,
		duckduckgo: false,
		perplexity: false,
		exa: true,
		gemini: false,
		kagi: false,
		bocha: false,
		ollama: false,
		anysearch: false,
		xai: false,
		brightdata: false,
		serpbase: false,
		serper: false,
		valyu: false,
	};

	assert.equal(resolveCuratorDefaultProvider("auto", available, { model: { provider: "openai-codex" } }), "openai");
	assert.equal(resolveCuratorDefaultProvider("auto", available, { model: { provider: "openai" } }), "exa");
	assert.equal(resolveCuratorDefaultProvider("auto", { ...available, exa: false }, { model: { provider: "openai" } }), "openai");
	assert.equal(resolveCuratorDefaultProvider("auto", { ...available, openai: false, exa: false, bocha: true, ollama: true }), "bocha");
});

test("auto search prefers Codex-backed OpenAI search when the selected model is openai-codex", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-auto-codex-selected-"));
	const child = runChild(`
		let capturedUrl = "";
		globalThis.fetch = async (url) => {
			capturedUrl = String(url);
			if (capturedUrl !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error("Expected Codex search first, got " + capturedUrl);
			}
			return new Response(JSON.stringify({
				output: [
					{ type: "web_search_call", action: { sources: [] } },
					{ type: "message", content: [{ type: "output_text", text: "codex search answer" }] },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const ctx = {
			model: { provider: "openai-codex", id: "gpt-5.6-terra" },
			modelRegistry: {
				getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-token", headers: {} }),
			},
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("current model search", { provider: "auto", extensionContext: ctx });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, capturedUrl }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "openai");
	assert.equal(output.answer, "codex search answer");
	assert.equal(output.capturedUrl, "https://chatgpt.com/backend-api/codex/responses");
});

test("auto search keeps selected Codex-backed OpenAI for result counts and recency filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-auto-codex-options-"));
	const child = runChild(`
		globalThis.fetch = async (url) => {
			const requestUrl = String(url);
			if (requestUrl === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(JSON.stringify({
					output: [
						{ type: "web_search_call", action: { sources: [] } },
						{ type: "message", content: [{ type: "output_text", text: "codex option answer" }] },
					],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (requestUrl.startsWith("https://mcp.exa.ai/mcp")) {
				const event = { result: { content: [{ type: "text", text: "Title: Exa Fallback\\nURL: https://exa.example/fallback\\nText: fallback answer" }] } };
				return new Response("data: " + JSON.stringify(event) + "\\n\\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			throw new Error("Unexpected fetch " + requestUrl);
		};

		const ctx = {
			model: { provider: "openai-codex", id: "gpt-5.6-terra" },
			modelRegistry: {
				getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-token", headers: {} }),
			},
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const results = [];
		for (const numResults of [1, 20]) {
			for (const recencyFilter of ["day", "week", "month", "year"]) {
				const result = await search("current model search", {
					provider: "auto",
					extensionContext: ctx,
					numResults,
					recencyFilter,
				});
				results.push({ numResults, recencyFilter, provider: result.provider, answer: result.answer });
			}
		}
		console.log(JSON.stringify(results));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const results = JSON.parse(child.stdout.trim());
	assert.equal(results.length, 8);
	for (const result of results) {
		assert.equal(result.provider, "openai", `${result.numResults}/${result.recencyFilter}`);
		assert.equal(result.answer, "codex option answer", `${result.numResults}/${result.recencyFilter}`);
	}
});

test("auto search falls through to Exa when selected Codex-backed OpenAI fails", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-auto-codex-failure-"));
	const child = runChild(`
		globalThis.fetch = async (url) => {
			const requestUrl = String(url);
			if (requestUrl === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response("Codex unavailable", { status: 503 });
			}
			if (requestUrl.startsWith("https://mcp.exa.ai/mcp")) {
				const event = { result: { content: [{ type: "text", text: "Title: Exa Fallback\\nURL: https://exa.example/fallback\\nText: Exa after Codex failure" }] } };
				return new Response("data: " + JSON.stringify(event) + "\\n\\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			throw new Error("Unexpected fetch " + requestUrl);
		};

		const ctx = {
			model: { provider: "openai-codex", id: "gpt-5.6-terra" },
			modelRegistry: {
				getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-token", headers: {} }),
			},
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("current model search", {
			provider: "auto",
			extensionContext: ctx,
			numResults: 20,
			recencyFilter: "week",
		});
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "exa");
	assert.match(output.answer, /Exa after Codex failure/);
});

test("auto search uses Exa before OpenAI when the selected model is not openai-codex", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-auto-non-codex-selected-"));
	const child = runChild(`
		let capturedUrl = "";
		globalThis.fetch = async (url) => {
			capturedUrl = String(url);
			if (capturedUrl.startsWith("https://api.openai.com/") || capturedUrl.startsWith("https://chatgpt.com/")) {
				throw new Error("OpenAI must not run before Exa for a non-Codex selected model");
			}
			if (!capturedUrl.startsWith("https://mcp.exa.ai/mcp")) throw new Error("Unexpected fetch " + capturedUrl);
			const event = { result: { content: [{ type: "text", text: "Title: Exa Source\\nURL: https://exa.example/source\\nText: Exa selected first" }] } };
			return new Response("data: " + JSON.stringify(event) + "\\n\\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		const ctx = {
			model: { provider: "openai", id: "gpt-5.6-terra" },
			modelRegistry: {
				getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "codex-token", headers: {} }),
			},
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("current model search", { provider: "auto", extensionContext: ctx });
		console.log(JSON.stringify({ provider: result.provider, answer: result.answer, capturedUrl }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "exa");
	assert.match(output.answer, /Exa selected first/);
	assert.match(output.capturedUrl, /^https:\/\/mcp\.exa\.ai\/mcp/);
});

test("OpenAI search falls back to API key when model registry cannot enumerate", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-partial-registry-"));
	const child = runChild(`
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				output: [
					{ type: "web_search_call", action: { sources: [] } },
					{ type: "message", content: [{ type: "output_text", text: "fallback answer" }] },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("fallback docs", { numResults: 1 }, { modelRegistry: {} });
		console.log(JSON.stringify({ answer: result.answer, model: capturedBody.model }));
	`, {
		HOME: home,
		USERPROFILE: home,
		OPENAI_API_KEY: "sk-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.answer, "fallback answer");
	assert.equal(output.model, "gpt-5.6-terra");
});

test("OpenAI search uses configured model with selected registry auth", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-model-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		openaiSearchModel: "gateway-search-model",
	}) + "\n");
	const child = runChild(`
		let capturedBody = null;
		let selectedModel = null;
		globalThis.fetch = async (url, init) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				output: [
					{ type: "web_search_call", action: { sources: [] } },
					{ type: "message", content: [{ type: "output_text", text: "registry answer" }] },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const models = [
			{ provider: "openai", id: "gpt-5.9" },
			{ provider: "openai", id: "gpt-5.10-pro" },
			{ provider: "openai", id: "gpt-5.10" },
		];
		const ctx = {
			modelRegistry: {
				getAll: () => models,
				getApiKeyAndHeaders: async (model) => {
					selectedModel = model.id;
					return { ok: true, apiKey: "registry-key", headers: { "X-Registry": "yes" } };
				},
			},
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("registry docs", { numResults: 1 }, ctx);
		console.log(JSON.stringify({ answer: result.answer, requestModel: capturedBody.model, selectedModel }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.answer, "registry answer");
	assert.equal(output.requestModel, "gateway-search-model");
	assert.equal(output.selectedModel, "gpt-5.10");
});

test("OpenAI search honors configured provider priority", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-providers-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		openaiSearchProviders: ["unregistered-provider", "openai-codex-work", "openai-codex"],
	}) + "\n");
	const child = runChild(`
		let capturedAuthorization = "";
		globalThis.fetch = async (url, init) => {
			capturedAuthorization = init.headers.Authorization;
			return new Response(JSON.stringify({
				output: [
					{ type: "web_search_call", action: { sources: [] } },
					{ type: "message", content: [{ type: "output_text", text: "second account answer" }] },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const models = [
			{ provider: "openai-codex", id: "gpt-5.6-terra" },
			{ provider: "openai-codex-work", id: "gpt-5.6-terra" },
		];
		const ctx = {
			modelRegistry: {
				getAll: () => models,
				getApiKeyAndHeaders: async (model) => ({ ok: true, apiKey: model.provider + "-key", headers: {} }),
			},
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("priority docs", { numResults: 1 }, ctx);
		console.log(JSON.stringify({ answer: result.answer, capturedAuthorization }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.answer, "second account answer");
	assert.equal(output.capturedAuthorization, "Bearer openai-codex-work-key");
});

test("OpenAI search rejects invalid openaiSearchProviders", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-providers-invalid-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		openaiSearchProviders: ["openai-codex", ""],
	}) + "\n");
	const child = runChild(`
		const ctx = {
			modelRegistry: {
				getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "registry-key", headers: {} }),
			},
		};

		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const outcomes = {};
		for (const [label, maybeCtx] of [["withContext", ctx], ["withoutContext", undefined]]) {
			try {
				await searchWithOpenAI("invalid config", { numResults: 1 }, maybeCtx);
				outcomes[label] = { threw: false };
			} catch (err) {
				outcomes[label] = { threw: true, message: err.message };
			}
		}
		console.log(JSON.stringify({ outcomes, fetchCalls }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		OPENAI_API_KEY: "sk-must-not-be-billed",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.outcomes.withContext.threw, true);
	assert.match(output.outcomes.withContext.message, /openaiSearchProviders/);
	assert.equal(output.outcomes.withoutContext.threw, true);
	assert.match(output.outcomes.withoutContext.message, /openaiSearchProviders/);
	assert.equal(output.fetchCalls, 0);
});

test("Gemini API search uses its search-only default model", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-default-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedBody = null;
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedBody = JSON.parse(init.body);
			capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
			return new Response(JSON.stringify({
				candidates: [{ content: { parts: [{ text: "Gemini answer" }] } }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("latest TypeScript version", { provider: "gemini" });
		console.log(JSON.stringify({ capturedUrl, capturedBody, capturedHeaders, provider: result.provider }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		GEMINI_API_KEY: "gemini-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
	assert.equal(output.capturedHeaders["x-goog-api-key"], "gemini-test-key");
	assert.deepEqual(output.capturedBody.tools, [{ google_search: {} }]);
	assert.equal(output.provider, "gemini");
});

test("Gemini API search preserves the configured searchModel", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-configured-"));
	const child = runChild(`
		const { writeFile } = await import("node:fs/promises");
		await writeFile(process.env.PI_CODING_AGENT_DIR + "/web-search.json", JSON.stringify({ searchModel: "custom-gemini-model" }));

		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
			return new Response(JSON.stringify({
				candidates: [{ content: { parts: [{ text: "Gemini answer" }] } }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		await search("configured model", { provider: "gemini" });
		console.log(JSON.stringify({ capturedUrl, capturedHeaders }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		GEMINI_API_KEY: "gemini-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/custom-gemini-model:generateContent");
	assert.equal(output.capturedHeaders["x-goog-api-key"], "gemini-test-key");
});
