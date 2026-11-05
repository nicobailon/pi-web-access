import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cloroModuleUrl = new URL("../cloro.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const SEARCH_URL = "https://api.cloro.dev/v1/monitor/google";
const AIMODE_URL = "https://api.cloro.dev/v1/monitor/aimode";

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-cloro-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "CLORO_API_KEY", "CLORO_BASE_URL", "SERPLY_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY", "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY",
		"FIRECRAWL_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY",
		"SERPAPI_KEY", "SERPER_API_KEY", "ANYSEARCH_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "BRIGHTDATA_API_KEY", "VALYU_API_KEY",
		"SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

const organic = entries => JSON.stringify({ success: true, result: { organicResults: entries } });
const aimode = (text, sources) => JSON.stringify({ success: true, result: { text, sources } });

// Trimmed copies of live cloro responses (2026-11-05): the first rows only, and shortened redirectLink tokens.
// LIVE_GOOGLE was sent without include; LIVE_AIMODE without include.markdown; LIVE_AIMODE_MARKDOWN with it.
const LIVE_GOOGLE = { success: true, result: { organicResults: [
	{
		"position": 1,
		"title": "The 12 best rank tracker tools",
		"link": "https://zapier.com/blog/best-rank-tracker/",
		"displayedLink": "https://zapier.com > App picks > Best apps",
		"snippet": "Nov 27, 2024 — Semrush does just about everything you could ask an SEO tool to do exceptionally well, which is why it comes in as the best overall SEO tracker.",
		"page": 1,
		"redirectLink": "https://www.google.com/goto?url=CAESZwHEIkXXTZCWiif3AN2P5CyM"
	},
	{
		"position": 2,
		"title": "15 Best Rank Tracking Software We're Using for 2026",
		"link": "https://onelittleweb.com/top-tools/best-rank-tracking-software/",
		"displayedLink": "https://onelittleweb.com > Top Tools",
		"snippet": "Aug 26, 2026 — The best tools like Semrush, Ahrefs, SE Ranking, and AccuRanker now track how your brand shows up in AI Overviews, ChatGPT, and Gemini, not just ...",
		"page": 1,
		"redirectLink": "https://www.google.com/goto?url=CAESfAHEIkXXnZx8-CIkl8BqNIqn"
	},
	{
		"position": 3,
		"title": "14 best rank tracker software I'm using for SEO in 2026",
		"link": "https://www.marketermilk.com/blog/best-rank-tracker-software",
		"displayedLink": "https://www.marketermilk.com > blog > best-rank-track...",
		"snippet": "Jan 28, 2026 — Nightwatch (best for local keyword tracking); SERPWatcher by Mangools (best for SERP monitor); KeySearch (best for startups on a budget); Rank ...",
		"page": 1,
		"redirectLink": "https://www.google.com/goto?url=CAESeQHEIkXXsU_7cL03XeYKkDwE"
	}
] } };
const LIVE_AIMODE = {
	success: true,
	result: {
		text: "Evaluating rank tracking tools depends heavily on whether you need deep enterprise analytics, real-time updates, local SEO focus, or a budget-friendly option.\n\nComparative Matrix of Top Rank Trackers",
		sources: [
			{
				position: 1,
				label: "15 Best Rank Tracking Software (Tested on Real Campaigns)",
				url: "https://onelittleweb.com/top-tools/best-rank-tracking-software/",
				description: "Each of these tools cover different roles in real SEO workflows. 1. Semrush — Best all-in-one tracking for large teams 2. Ahrefs —...",
				redirectLink: "https://www.google.com/goto?url=CAESewHEIkXXE0FoLRk5u8ovdyyV",
			},
		],
		citationPills: [
			{
				label: "15 Best Rank Tracking Software (Tested on Real Campaigns)",
				citationPillId: 1,
				url: "https://onelittleweb.com/top-tools/best-rank-tracking-software/",
				domain: "onelittleweb.com",
				description: "Each of these tools cover different roles in real SEO workflows. 1. Semrush — Best all-in-one tracking for large teams 2. Ahrefs —...",
				position: 1,
				redirectLink: "https://www.google.com/goto?url=CAESewHEIkXXE0FoLRk5u8ovdyyV",
			},
		],
	},
};
const LIVE_AIMODE_MARKDOWN = {
	"success": true,
	"result": {
		"text": "Choosing the best rank tracking tool depends on factors like team size, agency reporting needs, budget, and tracking for emerging AI-driven search results.\n\nTop Categories and Tools",
		"sources": [
			{
				"position": 1,
				"label": "The 12 best rank tracker tools | Zapier",
				"url": "https://zapier.com/blog/best-rank-tracker/",
				"description": "Low-volume keyword tracking | Simple, intuitive tool suite for the price | From $49/month; has free SEO tools. All of its tools ar...",
				"redirectLink": "https://www.google.com/goto?url=CAESZwHEIkXXHMk2gUQTN1YAHtsh"
			},
			{
				"position": 2,
				"label": "15 Best Rank Tracking Software (Tested on Real Campaigns)",
				"url": "https://onelittleweb.com/top-tools/best-rank-tracking-software/",
				"description": "Google Search Console — Best free diagnostic tracker 13. Clean dashboards with historical graphs and landing page insights. Basic:",
				"redirectLink": "https://www.google.com/goto?url=CAESfAHEIkXX3vTWWBJYDPXr_HA6"
			}
		],
		"citationPills": [
			{
				"label": "The 12 best rank tracker tools | Zapier",
				"citationPillId": 1,
				"url": "https://zapier.com/blog/best-rank-tracker/",
				"domain": "zapier.com",
				"description": "Low-volume keyword tracking | Simple, intuitive tool suite for the price | From $49/month; has free SEO tools. All of its tools ar...",
				"position": 1,
				"redirectLink": "https://www.google.com/goto?url=CAESZwHEIkXXHMk2gUQTN1YAHtsh"
			}
		],
		"markdown": "Choosing the best rank tracking tool depends on factors like team size, agency reporting needs, budget, and tracking for emerging AI-driven search results.\n\nTop Categories and Tools\n\n  * **Enterprise & Premium Suites**\n    * **Semrush**: Ideal for large teams needing comprehensive multi-channel tracking, daily updates across devices, local and multilingual data, and built-in competitor analytics."
	}
};
const LIVE_BAD_KEY = { success: false, error: { code: "INVALID_API_KEY_FORMAT", message: "Invalid API key format", timestamp: "2026-11-05T21:11:31.240Z" } };

test("cloro maps live Google, AI Mode, and 401 response bodies", async () => {
	const googleHome = await createHome({ cloroApiKey: "cloro-test-key" });
	const aimodeHome = await createHome({ cloroApiKey: "cloro-test-key", cloroMode: "aimode" });
	const script = (body, status) => `
		globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status} });
		const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
		try {
			const result = await searchWithCloro("best rank tracker tools", { numResults: 10 });
			console.log(JSON.stringify(result));
		} catch (error) {
			console.log(JSON.stringify({ error: String(error) }));
		}
	`;
	try {
		const google = runChild(script(LIVE_GOOGLE, 200), { PI_CODING_AGENT_DIR: googleHome });
		assert.equal(google.status, 0, google.stderr);
		const googleResult = JSON.parse(google.stdout.trim());
		assert.deepEqual(googleResult.results, LIVE_GOOGLE.result.organicResults.map(row => ({ title: row.title, url: row.link, snippet: row.snippet })));
		assert.match(googleResult.answer, /The 12 best rank tracker tools/);

		const ai = runChild(script(LIVE_AIMODE, 200), { PI_CODING_AGENT_DIR: aimodeHome });
		assert.equal(ai.status, 0, ai.stderr);
		const aiResult = JSON.parse(ai.stdout.trim());
		assert.equal(aiResult.answer, LIVE_AIMODE.result.text, "text is the fallback when markdown is absent");
		assert.deepEqual(aiResult.results, [{
			title: "15 Best Rank Tracking Software (Tested on Real Campaigns)",
			url: "https://onelittleweb.com/top-tools/best-rank-tracking-software/",
			snippet: LIVE_AIMODE.result.sources[0].description,
		}]);

		const markdown = runChild(script(LIVE_AIMODE_MARKDOWN, 200), { PI_CODING_AGENT_DIR: aimodeHome });
		assert.equal(markdown.status, 0, markdown.stderr);
		const markdownResult = JSON.parse(markdown.stdout.trim());
		assert.equal(markdownResult.answer, LIVE_AIMODE_MARKDOWN.result.markdown, "markdown wins over text when present");
		assert.match(markdownResult.answer, /\*\*Enterprise & Premium Suites\*\*/);
		assert.deepEqual(markdownResult.results, LIVE_AIMODE_MARKDOWN.result.sources.map(source => ({ title: source.label, url: source.url, snippet: source.description })));

		const badKey = runChild(script(LIVE_BAD_KEY, 401), { PI_CODING_AGENT_DIR: googleHome });
		assert.equal(badKey.status, 0, badKey.stderr);
		assert.match(JSON.parse(badKey.stdout.trim()).error, /^Error: cloro error 401: .*"code":"INVALID_API_KEY_FORMAT"/);
	} finally {
		await rm(googleHome, { recursive: true, force: true });
		await rm(aimodeHome, { recursive: true, force: true });
	}
});

test("cloro maps organic results, domain filters, and environment credentials", async () => {
	const home = await createHome();
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...(init && init.headers) }, body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(organic([
				{ position: 1, title: "Allowed", link: "https://docs.example.com/a", snippet: "result" },
				{ position: 2, title: "Excluded", link: "https://private.docs.example.com/b", snippet: "private" },
				{ position: 3, title: "Outside", link: "https://example.net/c", snippet: "outside" },
			]))}, { status: 200 });
		};
		const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
		const result = await searchWithCloro("web query", { numResults: 3, domainFilter: ["example.com", "-private.docs.example.com"], recencyFilter: "week" });
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home, CLORO_API_KEY: "cloro-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());
	assert.equal(captured.url, SEARCH_URL, "the key must travel in the header, never the query string");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.Authorization, "Bearer cloro-test-key");
	assert.equal(captured.headers["Content-Type"], "application/json");
	assert.equal(captured.headers["User-Agent"], "pi-web-access");
	assert.deepEqual(captured.body, { query: "web query site:example.com -site:private.docs.example.com", country: "US" });
	assert.deepEqual(result.results, [{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" }]);
	await rm(home, { recursive: true, force: true });
});

test("cloro sends the same body for every recency filter and numResults", async () => {
	const home = await createHome({ cloroApiKey: "cloro-test-key" });
	try {
		const child = runChild(`
			const bodies = [];
			globalThis.fetch = async (_url, init) => {
				bodies.push(JSON.parse(init.body));
				return new Response(${JSON.stringify(organic([{ title: "Result", link: "https://example.com/result", snippet: "" }]))});
			};
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			for (const recencyFilter of [undefined, "day", "year"]) await searchWithCloro("recency", { recencyFilter });
			await searchWithCloro("many", { numResults: 50 });
			console.log(JSON.stringify(bodies));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), [
			{ query: "recency", country: "US" },
			{ query: "recency", country: "US" },
			{ query: "recency", country: "US" },
			{ query: "many", country: "US" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("cloro trims results to numResults and groups several allowed domains", async () => {
	const home = await createHome({ cloroApiKey: "cloro-test-key" });
	try {
		const child = runChild(`
			let query;
			globalThis.fetch = async (_url, init) => {
				query = JSON.parse(init.body).query;
				return new Response(${JSON.stringify(organic(Array.from({ length: 10 }, (_, index) => ({ title: "Result " + index, link: "https://example.com/" + index, snippet: "" }))))});
			};
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			const result = await searchWithCloro("many", { numResults: 2, domainFilter: ["example.com", "example.org"] });
			console.log(JSON.stringify({ query, urls: result.results.map(entry => entry.url) }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.query, "many (site:example.com OR site:example.org)");
		assert.deepEqual(output.urls, ["https://example.com/0", "https://example.com/1"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("cloro retains credentials for same-origin redirects and strips them cross-origin", async () => {
	const home = await createHome({ cloroApiKey: "cloro-test-key" });
	try {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url, init) => {
				const target = String(url);
				calls.push({ target, key: new Headers(init.headers).get("Authorization"), method: init.method, redirect: init.redirect });
				if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "/v1/redirected" } });
				if (calls.length === 2) return new Response(null, { status: 308, headers: { location: "https://results.example/search" } });
				return new Response(${JSON.stringify(organic([{ title: "Result", link: "https://example.com/result" }]))});
			};
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			await searchWithCloro("redirect");
			console.log(JSON.stringify(calls));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const calls = JSON.parse(child.stdout.trim());
		assert.deepEqual(calls, [
			{ target: SEARCH_URL, key: "Bearer cloro-test-key", method: "POST", redirect: "manual" },
			{ target: "https://api.cloro.dev/v1/redirected", key: "Bearer cloro-test-key", method: "POST", redirect: "manual" },
			{ target: "https://results.example/search", key: null, method: "POST", redirect: "manual" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("cloro publishes only resolved absolute HTTP(S) result URLs", async () => {
	const home = await createHome({ cloroApiKey: "cloro-test-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async () => new Response(${JSON.stringify(organic([
				{ title: "HTTPS", link: "https://example.com/secure" },
				{ title: "HTTP", link: "http://example.com/plain" },
				{ title: "Unresolved", link: "", redirectLink: "https://www.google.com/goto?url=abc" },
				{ title: "Goto", link: "https://www.google.com/goto?url=abc" },
				{ title: "Relative", link: "/relative" },
				{ title: "Malformed", link: "not a url" },
				{ title: "File", link: "file:///tmp/result" },
				{ title: "Data", link: "data:text/plain,result" },
				{ title: "Missing link" },
				null,
			]))});
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			const result = await searchWithCloro("links", { numResults: 10 });
			console.log(JSON.stringify(result.results));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), [
			{ title: "HTTPS", url: "https://example.com/secure", snippet: "" },
			{ title: "HTTP", url: "http://example.com/plain", snippet: "" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("cloro needs a key and resolves config, environment, and $NAME credential sources", async () => {
	const home = await createHome();
	try {
		const missing = runChild(`
			const { searchWithCloro, isCloroAvailable } = await import(${JSON.stringify(cloroModuleUrl)});
			let error; try { await searchWithCloro("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify({ available: isCloroAvailable(), error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(missing.status, 0, missing.stderr);
		const output = JSON.parse(missing.stdout.trim());
		assert.equal(output.available, false);
		assert.match(output.error, /^cloro API key not found\. Either:/);
		assert.match(output.error, /"cloroApiKey": "your-key"/);
		assert.match(output.error, /CLORO_API_KEY environment variable/);
		assert.match(output.error, /https:\/\/dashboard\.cloro\.dev\/api-keys\?utm_source=pi-web-access&utm_medium=byok/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
	for (const [config, env, expected] of [
		[{ cloroApiKey: "config-key" }, {}, "Bearer config-key"],
		[{}, { CLORO_API_KEY: "env-key" }, "Bearer env-key"],
		[{ cloroApiKey: "$CLORO_VAULT_KEY" }, { CLORO_VAULT_KEY: "vault-key" }, "Bearer vault-key"],
	]) {
		const sourceHome = await createHome(config);
		try {
			const child = runChild(`
				let auth;
				globalThis.fetch = async (url, init) => { auth = new Headers(init.headers).get("Authorization"); return new Response(${JSON.stringify(organic([]))}); };
				const { searchWithCloro, isCloroAvailable } = await import(${JSON.stringify(cloroModuleUrl)});
				const available = isCloroAvailable();
				const result = await searchWithCloro("q");
				console.log(JSON.stringify({ available, auth, results: result.results }));
			`, { PI_CODING_AGENT_DIR: sourceHome, ...env });
			assert.equal(child.status, 0, child.stderr);
			assert.deepEqual(JSON.parse(child.stdout.trim()), { available: true, auth: expected, results: [] });
		} finally {
			await rm(sourceHome, { recursive: true, force: true });
		}
	}
});

test("cloro AI Mode posts the prompt and returns the answer text with its sources", async () => {
	const home = await createHome({ cloroApiKey: "cloro-test-key", cloroMode: "aimode" });
	try {
		const child = runChild(`
			let captured;
			globalThis.fetch = async (url, init) => {
				captured = { url: String(url), method: init.method, auth: new Headers(init.headers).get("Authorization"), body: JSON.parse(init.body) };
				return new Response(${JSON.stringify(aimode("  AI Mode answer.  ", [
					{ position: 1, label: "Allowed", url: "https://docs.example.com/a", description: "first" },
					{ position: 2, label: "Outside", url: "https://example.net/b", description: "outside" },
					{ position: 3, label: "Unresolved", url: "https://www.google.com/goto?url=abc", redirectLink: "https://www.google.com/goto?url=abc" },
					{ position: 4, url: "https://example.com/c" },
				]))});
			};
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			const result = await searchWithCloro("what is x", { numResults: 5, domainFilter: ["example.com"] });
			console.log(JSON.stringify({ captured, result }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const { captured, result } = JSON.parse(child.stdout.trim());
		assert.equal(captured.url, AIMODE_URL);
		assert.equal(captured.method, "POST");
		assert.equal(captured.auth, "Bearer cloro-test-key");
		assert.deepEqual(captured.body, { prompt: "what is x", country: "US", include: { markdown: true } }, "AI Mode gets the plain prompt; domain filters apply locally");
		assert.equal(result.answer, "AI Mode answer.");
		assert.deepEqual(result.results, [
			{ title: "Allowed", url: "https://docs.example.com/a", snippet: "first" },
			{ title: "Source 2", url: "https://example.com/c", snippet: "" },
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("cloro rejects an unknown cloroMode before sending a request and an AI Mode body without text", async () => {
	const badHome = await createHome({ cloroApiKey: "cloro-test-key", cloroMode: "chatgpt" });
	const aimodeHome = await createHome({ cloroApiKey: "cloro-test-key", cloroMode: "aimode" });
	try {
		const bad = runChild(`
			let calls = 0;
			globalThis.fetch = async () => { calls++; return new Response("{}"); };
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			let error; try { await searchWithCloro("q"); } catch (e) { error = e.message; }
			console.log(JSON.stringify({ calls, error }));
		`, { PI_CODING_AGENT_DIR: badHome });
		assert.equal(bad.status, 0, bad.stderr);
		const badOutput = JSON.parse(bad.stdout.trim());
		assert.equal(badOutput.calls, 0);
		assert.match(badOutput.error, /cloroMode .* must be one of: google, aimode/);

		const missingText = runChild(`
			globalThis.fetch = async () => new Response(JSON.stringify({ success: true, result: { sources: [] } }));
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			let error; try { await searchWithCloro("q"); } catch (e) { error = String(e); }
			console.log(JSON.stringify({ error }));
		`, { PI_CODING_AGENT_DIR: aimodeHome });
		assert.equal(missingText.status, 0, missingText.stderr);
		assert.match(JSON.parse(missingText.stdout.trim()).error, /cloro returned invalid response: expected result\.markdown or result\.text string/);
	} finally {
		await rm(badHome, { recursive: true, force: true });
		await rm(aimodeHome, { recursive: true, force: true });
	}
});

test("cloro supports explicit selection but is excluded from auto and provider all", async () => {
	const home = await createHome({ cloroApiKey: "cloro-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith(${JSON.stringify(SEARCH_URL)})) return new Response(${JSON.stringify(organic([{ title: "cloro", link: "https://example.com", snippet: "result" }]))}, { status: 200 });
			if (target.startsWith("https://mcp.exa.ai/mcp")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }), { status: 200 });
			throw new Error("Unexpected fetch " + target);
		};
		const { search, ALL_SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS, providerLabel } = await import(${JSON.stringify(searchModuleUrl)});
		const explicit = await search("explicit", { provider: "cloro" });
		const auto = await search("auto", { provider: "auto" });
		const all = await search("all", { provider: "all" });
		console.log(JSON.stringify({
			explicitProvider: explicit.provider, autoProvider: auto.provider, allProviders: all.providerResponses.map(result => result.provider), calls,
			resolved: RESOLVED_SEARCH_PROVIDERS.includes("cloro"), inAll: ALL_SEARCH_PROVIDERS.includes("cloro"), label: providerLabel("cloro"),
		}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.explicitProvider, "cloro");
	assert.equal(output.autoProvider, "exa");
	assert.deepEqual(output.allProviders, ["exa"]);
	assert.equal(output.calls.filter(url => url === SEARCH_URL).length, 1);
	assert.equal(output.resolved, true);
	assert.equal(output.inAll, false);
	assert.equal(output.label, "cloro");
	await rm(home, { recursive: true, force: true });
});

test("cloro provider timeouts can fall through configured routing", async () => {
	const home = await createHome({
		cloroApiKey: "cloro-test-key",
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["cloro", "brave"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const target = String(url);
			calls.push(target);
			if (target.startsWith(${JSON.stringify(SEARCH_URL)})) {
				const error = new Error("The operation was aborted due to timeout");
				error.name = "TimeoutError";
				throw error;
			}
			if (target.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("timeout route", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "brave");
	assert.ok(output.calls[0] === SEARCH_URL);
	assert.ok(output.calls[1].startsWith("https://api.search.brave.com/res/v1/web/search"));
	await rm(home, { recursive: true, force: true });
});

test("cloro errors keep the HTTP status so searchRouting classifies quota and auth failures", async () => {
	for (const [status, kind, fallsBack] of [[429, "quota", true], [503, "transient", true], [401, "quota", false]]) {
		const home = await createHome({
			cloroApiKey: "cloro-test-key",
			braveApiKey: "brave-test-key",
			searchRouting: { providers: ["cloro", "brave"], fallbackOn: [kind] },
		});
		try {
			const child = runChild(`
				globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL)})
					? new Response(JSON.stringify({ success: false, error: { code: "ERROR", message: "status ${status} cloro-test-key" } }), { status: ${status} })
					: new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
				const { search } = await import(${JSON.stringify(searchModuleUrl)});
				try {
					const result = await search("status route", { provider: "auto" });
					console.log(JSON.stringify({ provider: result.provider }));
				} catch (error) {
					console.log(JSON.stringify({ error: String(error) }));
				}
			`, { PI_CODING_AGENT_DIR: home });
			assert.equal(child.status, 0, child.stderr);
			const output = JSON.parse(child.stdout.trim());
			if (fallsBack) assert.equal(output.provider, "brave", `${status} should fall back on ${kind}`);
			else {
				assert.match(output.error, new RegExp(`cloro error ${status}: `));
				assert.match(output.error, /\[redacted\]/);
			}
			assert.doesNotMatch(child.stdout + child.stderr, /cloro-test-key/);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	}
});

for (const status of [200, 503]) {
	for (const mode of ["deadline", "caller"]) {
		test(`cloro delayed ${status} body honors ${mode} cancellation routing`, async () => {
			const home = await createHome({
				cloroApiKey: "cloro-test-key",
				braveApiKey: "brave-test-key",
				searchRouting: { providers: ["cloro", "brave"], fallbackOn: ["network"] },
			});
			try {
				const child = runChild(`
					import { createServer } from "node:http";
					const server = createServer((_request, response) => {
						response.writeHead(${status}, { "content-type": "application/json" });
						response.write("{");
					});
					await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
					const caller = new AbortController();
					const originalTimeout = AbortSignal.timeout;
					AbortSignal.timeout = ms => originalTimeout(ms === 120000 ? 1000 : ms);
					const realFetch = globalThis.fetch;
					const calls = [];
					let headersReceived = false;
					globalThis.fetch = async (url, init) => {
						const host = new URL(url).hostname;
						calls.push(host);
						if (host === "api.cloro.dev") {
							const response = await realFetch("http://127.0.0.1:" + server.address().port, init);
							headersReceived = true;
							if (${JSON.stringify(mode)} === "caller") setTimeout(() => caller.abort(), 20);
							return response;
						}
						if (host === "api.search.brave.com") return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com", description: "fallback" }] } }));
						throw new Error("Unexpected fetch " + host);
					};
					try {
						const { search } = await import(${JSON.stringify(searchModuleUrl)});
						try {
							const result = await search("delayed body", { provider: "auto", signal: caller.signal });
							console.log(JSON.stringify({ provider: result.provider, calls, headersReceived }));
						} catch (error) {
							console.log(JSON.stringify({ error: String(error), calls, headersReceived }));
						}
					} finally {
						server.closeAllConnections();
						await new Promise(resolve => server.close(resolve));
					}
				`, { PI_CODING_AGENT_DIR: home });
				assert.equal(child.status, 0, child.stderr);
				const output = JSON.parse(child.stdout.trim());
				assert.equal(output.headersReceived, true, "must reach response-body consumption before cancellation");
				if (mode === "deadline") {
					assert.equal(output.provider, "brave", output.error);
					assert.deepEqual(output.calls, ["api.cloro.dev", "api.search.brave.com"]);
				} else {
					assert.match(output.error, /cloro search failed \(aborted\)/i);
					assert.deepEqual(output.calls, ["api.cloro.dev"]);
				}
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}
}

test("cloro redacts the resolved credential in JSON error envelopes and rejects malformed bodies", async () => {
	const home = await createHome({ cloroApiKey: "unused-config-key" });
	try {
		const child = runChild(`
			const bodies = [
				JSON.stringify({ success: false, error: { code: "INVALID_API_KEY", message: "Invalid API key resolved-cloro-secret", timestamp: "2026-11-04T00:00:00.000Z" } }),
				JSON.stringify({ success: true }),
				JSON.stringify({ success: true, result: {} }),
				"[]",
				"not json",
			];
			globalThis.fetch = async () => new Response(bodies.shift(), { status: 200 });
			const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
			const errors = [];
			for (let index = 0; index < 5; index++) {
				try { await searchWithCloro("redact envelope"); errors.push(null); } catch (error) { errors.push(String(error)); }
			}
			console.log(JSON.stringify(errors));
		`, { PI_CODING_AGENT_DIR: home, CLORO_API_KEY: "resolved-cloro-secret" });
		assert.equal(child.status, 0, child.stderr);
		const errors = JSON.parse(child.stdout.trim());
		assert.match(errors[0], /^Error: cloro returned invalid response: Invalid API key \[redacted\]$/);
		assert.match(errors[1], /cloro returned invalid response: expected result object/);
		assert.match(errors[2], /cloro returned invalid response: expected result\.organicResults array/);
		assert.match(errors[3], /cloro returned invalid response: expected an object envelope/);
		assert.match(errors[4], /cloro returned invalid JSON: /);
		assert.doesNotMatch(child.stdout + child.stderr, /resolved-cloro-secret/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("cloro redacts API errors and appears in the Curator", async () => {
	const home = await createHome({ cloroApiKey: "cloro-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ error: "Invalid API key cloro-secret." }), { status: 401 });
		const { searchWithCloro } = await import(${JSON.stringify(cloroModuleUrl)});
		try { await searchWithCloro("redact"); } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /^Error: cloro error 401: \{"error":"Invalid API key \[redacted\]\."\}$/);
	assert.doesNotMatch(output.error, /cloro-secret/);

	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, cloro: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "cloro", "cloro", [], null);
	assert.match(page, /data-provider="cloro"/);
	assert.match(page, />cloro<\/button>/);
	assert.match(page, /provider === "cloro"\) return "cloro"/);
	assert.match(page, /var providers = \[[^\]]*"cloro"[^\]]*\]/);
	await rm(home, { recursive: true, force: true });
});

test("cloro is selectable through webSearch.allowedProviders and reported in availability", async () => {
	const home = await createHome({ webSearch: { allowedProviders: ["cloro"] }, cloroApiKey: "cloro-test-key" });
	try {
		const child = runChild(`
			globalThis.fetch = async (url) => String(url).startsWith(${JSON.stringify(SEARCH_URL)})
				? new Response(${JSON.stringify(organic([{ title: "cloro", link: "https://example.com/cloro", snippet: "answer" }]))}, { status: 200 })
				: new Response("unexpected " + url, { status: 500 });
			const { search, getAllowedSearchProviders, parseProviderArgument } = await import(${JSON.stringify(searchModuleUrl)});
			const response = await search("q", { provider: "cloro" });
			let blocked; try { await search("q", { provider: "serply" }); } catch (error) { blocked = String(error); }
			console.log(JSON.stringify({ provider: response.provider, urls: response.results.map(entry => entry.url), allowed: [...getAllowedSearchProviders()], parsed: parseProviderArgument("cloro"), blocked }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.provider, "cloro");
		assert.deepEqual(output.urls, ["https://example.com/cloro"]);
		assert.deepEqual(output.allowed, ["cloro"]);
		assert.equal(output.parsed, "cloro");
		assert.match(output.blocked, /serply/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
