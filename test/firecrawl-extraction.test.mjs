import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const firecrawlModuleUrl = new URL("../firecrawl.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_KEY",
		"FIRECRAWL_API_VERSION", "FIRECRAWL_FRESH_SCRAPE", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "GEMINI_API_KEY",
		"BRIGHTDATA_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "BRIGHTDATA_UNLOCKER_ZONE",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

const PUBLIC_LOOKUP = `async () => [{ address: "93.184.216.34", family: 4 }]`;

async function configHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-firecrawl-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

test("Firecrawl extraction maps markdown, uses credentials, and defaults to lockdown", async () => {
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ success: true, data: { markdown: "# Body", metadata: { title: "Title" } } }), { status: 200 });
		};
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://example.com/article", undefined, {
			lookup: ${PUBLIC_LOOKUP},
		});
		console.log(JSON.stringify({ captured, result }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com/", FIRECRAWL_API_KEY: "fc-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://crawl.example.com/v2/scrape");
	assert.equal(output.captured.headers.authorization, "Bearer fc-test-key");
	assert.deepEqual(output.captured.body, { url: "https://example.com/article", formats: ["markdown"], onlyMainContent: true, lockdown: true });
	assert.deepEqual(output.result, { url: "https://example.com/article", title: "Title", content: "# Body", error: null });
});

test("Firecrawl search maps shared options and inline Markdown", async () => {
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				success: true,
				data: { web: [
					{ title: "Docs", description: "Firecrawl docs", url: "https://docs.firecrawl.dev/search", markdown: "# Firecrawl Search" },
					{ title: "Blocked", description: "Blocked", url: "https://spam.example/result", markdown: "spam" },
				] },
			}), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("firecrawl docs", {
			provider: "firecrawl",
			domainFilter: ["https://docs.firecrawl.dev/search", "-spam.example"],
			recencyFilter: "week",
			numResults: 4,
			includeContent: true,
			lookup: ${PUBLIC_LOOKUP},
		});
		console.log(JSON.stringify({ captured, result }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com/", FIRECRAWL_API_KEY: "fc-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://crawl.example.com/v2/search");
	assert.equal(output.captured.headers.authorization, "Bearer fc-test-key");
	assert.deepEqual(output.captured.body, {
		query: "firecrawl docs",
		limit: 4,
		sources: ["web"],
		includeDomains: ["docs.firecrawl.dev"],
		tbs: "qdr:w",
		scrapeOptions: { formats: ["markdown"], onlyMainContent: true, lockdown: true },
	});
	assert.equal(output.result.provider, "firecrawl");
	assert.deepEqual(output.result.results, [{ title: "Docs", url: "https://docs.firecrawl.dev/search", snippet: "Firecrawl docs" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://docs.firecrawl.dev/search", title: "Docs", content: "# Firecrawl Search", error: null }]);
});

test("Firecrawl search accepts v1 flat result arrays", async () => {
	const child = runChild(`
		let capturedUrl = "";
		globalThis.fetch = async (url) => {
			capturedUrl = String(url);
			return new Response(JSON.stringify({
				success: true,
				data: [{ title: "V1 result", description: "V1 snippet", url: "https://example.com/v1", markdown: "# V1" }],
			}), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("v1 firecrawl", { provider: "firecrawl", includeContent: true, lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ capturedUrl, result }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com/", FIRECRAWL_API_VERSION: "v1" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://crawl.example.com/v1/search");
	assert.deepEqual(output.result.results, [{ title: "V1 result", url: "https://example.com/v1", snippet: "V1 snippet" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://example.com/v1", title: "V1 result", content: "# V1", error: null }]);
});

test("Firecrawl API base allows configured loopback without global SSRF allow ranges", async () => {
	for (const firecrawlBaseUrl of ["http://localhost:3002", "http://127.0.0.1:3002"]) {
		const home = await configHome({ firecrawlBaseUrl });
		const child = runChild(`
			let calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response(JSON.stringify({ success: true, data: { web: [{ title: "Local", url: "https://example.com/local", description: "local" }] } }), { status: 200 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const result = await search("local firecrawl", { provider: "firecrawl" });
			console.log(JSON.stringify({ calls, result }));
		`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.calls, [`${firecrawlBaseUrl}/v2/search`]);
		assert.deepEqual(output.result.results, [{ title: "Local", url: "https://example.com/local", snippet: "local" }]);
	}
});

test("Firecrawl search honors configured SSRF allow ranges", async () => {
	const home = await configHome({
		firecrawlBaseUrl: "http://127.0.0.1:3002",
		ssrf: { allowRanges: ["127.0.0.0/8"] },
	});
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response(JSON.stringify({ success: true, data: { web: [{ title: "Local", url: "https://example.com/local", description: "local" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("local firecrawl", { provider: "firecrawl" });
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["http://127.0.0.1:3002/v2/search"]);
	assert.deepEqual(output.result.results, [{ title: "Local", url: "https://example.com/local", snippet: "local" }]);
});

test("Firecrawl fresh scraping is explicit opt-in", async () => {
	for (const env of [{}, { FIRECRAWL_FRESH_SCRAPE: "1" }]) {
		const home = await configHome({ firecrawlBaseUrl: "https://crawl.example.com", firecrawlFreshScrape: true });
		const child = runChild(`
			let body = null;
			globalThis.fetch = async (_url, init) => {
				body = JSON.parse(init.body);
				return new Response(JSON.stringify({ success: true, data: { markdown: "Fresh body" } }), { status: 200 });
			};
			const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
			await extractWithFirecrawl("https://example.com/fresh", undefined, { lookup: ${PUBLIC_LOOKUP} });
			console.log(JSON.stringify({ body }));
		`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, ...env });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()).body, { url: "https://example.com/fresh", formats: ["markdown"], onlyMainContent: true });
	}
});

test("Firecrawl PDF page cap is sent on scrape and reports truncation", async () => {
	const home = await configHome({ firecrawlBaseUrl: "https://crawl.example.com", firecrawlPdfMaxPages: 3 });
	const child = runChild(`
		let body = null;
		globalThis.fetch = async (_url, init) => {
			body = JSON.parse(init.body);
			return new Response(JSON.stringify({ success: true, data: { markdown: "# Report", metadata: { title: "Report", numPages: 3, totalPages: 15 } } }), { status: 200 });
		};
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const result = await extractWithFirecrawl("https://example.com/report.pdf", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ body, result }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.body, {
		url: "https://example.com/report.pdf",
		formats: ["markdown"],
		onlyMainContent: true,
		lockdown: true,
		parsers: [{ type: "pdf", maxPages: 3 }],
	});
	assert.equal(output.result.content, "# Report\n\n---\n\n*[Truncated: Only first 3 of 15 PDF pages parsed by Firecrawl]*");
});

test("Firecrawl PDF page cap is sent in search scrape options", async () => {
	const home = await configHome({ firecrawlBaseUrl: "https://crawl.example.com", firecrawlPdfMaxPages: 50 });
	const child = runChild(`
		let body = null;
		globalThis.fetch = async (_url, init) => {
			body = JSON.parse(init.body);
			return new Response(JSON.stringify({ success: true, data: { web: [{ title: "Doc", url: "https://example.com/doc.pdf", markdown: "# Doc" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		await search("pdf", { provider: "firecrawl", includeContent: true, lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ body }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()).body.scrapeOptions, {
		formats: ["markdown"],
		onlyMainContent: true,
		lockdown: true,
		parsers: [{ type: "pdf", maxPages: 50 }],
	});
});

test("Firecrawl rejects invalid PDF page caps and v1 caps before calling the API", async () => {
	for (const config of [
		{ firecrawlPdfMaxPages: 0 },
		{ firecrawlPdfMaxPages: 2.5 },
		{ firecrawlPdfMaxPages: "50" },
		{ firecrawlPdfMaxPages: 50, firecrawlApiVersion: "v1" },
	]) {
		const home = await configHome({ firecrawlBaseUrl: "https://crawl.example.com", ...config });
		const child = runChild(`
			let fetchCalls = 0;
			globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };
			const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
			let error = null;
			try { await extractWithFirecrawl("https://example.com/report.pdf", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
			catch (err) { error = err.message; }
			console.log(JSON.stringify({ error, fetchCalls }));
		`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.fetchCalls, 0);
		assert.match(output.error, config.firecrawlApiVersion === "v1" ? /firecrawlPdfMaxPages .*requires Firecrawl API v2/ : /firecrawlPdfMaxPages .*must be a positive integer/);
	}
});

test("private Firecrawl base URLs require an explicit narrow SSRF range", async () => {
	const home = await configHome({
		firecrawlBaseUrl: "http://127.0.0.1:3002",
		ssrf: { allowRanges: ["127.0.0.0/8"] },
	});
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response(JSON.stringify({ success: true, data: { markdown: "Local body", metadata: { title: "Local" } } }), { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/article", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls.slice(0, 2), ["https://example.com/article", "http://127.0.0.1:3002/v2/scrape"]);
	assert.equal(output.result.content, "Local body");
});

test("Firecrawl rejects private targets without invoking the configured instance", async () => {
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("{}", { status: 200 }); };
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const errors = [];
		for (const target of ["http://127.0.0.1:8080/admin", "http://localhost:8080/admin", "http://169.254.169.254/latest/meta-data"]) {
			try { await extractWithFirecrawl(target); } catch (err) { errors.push(err.message); }
		}
		try { await extractWithFirecrawl("https://internal.example.com/", undefined, { lookup: async () => [{ address: "10.0.0.5", family: 4 }] }); }
		catch (err) { errors.push(err.message); }
		console.log(JSON.stringify({ errors, fetchCalls }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.errors.length, 4);
	assert.equal(output.fetchCalls, 0);
});

test("Firecrawl validates configured base redirects and strips auth on public cross-origin redirects", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), auth: Object.fromEntries(new Headers(init.headers)).authorization ?? null });
			if (calls.length === 1) return new Response("", { status: 307, headers: { location: "https://other.example.com/v2/scrape" } });
			return new Response(JSON.stringify({ success: true, data: { markdown: "Redirect body" } }), { status: 200 });
		};
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		await extractWithFirecrawl("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com", FIRECRAWL_API_KEY: "fc-secret" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()).calls, [
		{ url: "https://crawl.example.com/v2/scrape", auth: "Bearer fc-secret" },
		{ url: "https://other.example.com/v2/scrape", auth: null },
	]);
});

test("Firecrawl blocks configured base redirects to private targets", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
		};
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		let redirectError = null;
		try { await extractWithFirecrawl("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { redirectError = err.message; }
		console.log(JSON.stringify({ calls, redirectError }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://crawl.example.com/v2/scrape"]);
	assert.match(output.redirectError, /Blocked internal address/);
});

test("Firecrawl malformed success envelopes throw visible shape errors", async () => {
	const child = runChild(`
		const responses = [
			{ success: true },
			{ success: true, data: null },
			{ success: true, data: {} },
		];
		let index = 0;
		globalThis.fetch = async () => new Response(JSON.stringify(responses[index++]), { status: 200 });
		const { extractWithFirecrawl } = await import(${JSON.stringify(firecrawlModuleUrl)});
		const errors = [];
		for (let i = 0; i < responses.length; i++) {
			try { await extractWithFirecrawl("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
			catch (err) { errors.push(err.message); }
		}
		console.log(JSON.stringify({ errors }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const errors = JSON.parse(child.stdout.trim()).errors;
	assert.deepEqual(errors, [
		"Firecrawl scrape returned an unexpected data shape",
		"Firecrawl scrape returned an unexpected data shape",
		"Firecrawl scrape returned markdown in an unexpected shape",
	]);
});

test("fetch_content prefers configured Firecrawl before hosted fallbacks", async () => {
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response(JSON.stringify({ success: true, data: { markdown: "Rendered body", metadata: { title: "Rendered" } } }), { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/client-rendered", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`, { FIRECRAWL_BASE_URL: "https://crawl.example.com" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.com/client-rendered", "https://crawl.example.com/v2/scrape"]);
	assert.deepEqual(output.result, { url: "https://example.com/client-rendered", title: "Rendered", content: "Rendered body", error: null });
});

test("Firecrawl extraction errors remain visible in fetch_content guidance", async () => {
	const home = await configHome({ firecrawlBaseUrl: "https://crawl.example.com" });
	const child = runChild(`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			return new Response("gateway", { status: 502 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/client-rendered", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, error: result.error }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Firecrawl fallback failed: Firecrawl scrape error 502/);
});
