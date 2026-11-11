import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../apify.ts", import.meta.url).href;
const SEARCH_URL = "https://web-search.apify.actor/";
const FETCH_URL = "https://web-fetch.apify.actor/";

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-apify-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (/_API_KEY$|_BASE_URL$|^APIFY_TOKEN$/.test(key)) delete childEnv[key];
	}
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

const searchReply = results => JSON.stringify({ query: "q", search: { provider: "google" }, results });
const fetchReply = (markdown, extra = {}) => JSON.stringify({
	url: "https://example.com/page",
	fetch: { loadedUrl: "https://example.com/page", httpStatusCode: 200, contentType: "text/html" },
	metadata: { title: " Page " },
	markdown,
	...extra,
});

async function withHome(config, fn) {
	const home = await createHome(config);
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("Apify Web Search posts the query with native filters and keeps the token in the header", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			let captured;
			globalThis.fetch = async (url, init) => {
				captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
				return new Response(${JSON.stringify(searchReply([
					{ position: 1, url: "https://docs.example.com/a", title: "Allowed", snippet: "result" },
					{ position: 2, url: "https://private.docs.example.com/b", title: "Excluded", snippet: "private" },
					{ position: 3, url: "https://example.net/c", title: "Outside", snippet: "outside" },
					{ position: 4, url: "ftp://docs.example.com/d", title: "Not http", snippet: "ftp" },
					{ position: 5, url: "https://docs.example.com/e", title: " ", snippet: null },
				]))}, { status: 200 });
			};
			const { searchWithApify } = await import(${JSON.stringify(moduleUrl)});
			const result = await searchWithApify("web query", { numResults: 5, recencyFilter: "week", domainFilter: ["example.com", "-private.docs.example.com"] });
			console.log(JSON.stringify({ captured, result }));
		`, { PI_CODING_AGENT_DIR: home, APIFY_TOKEN: "apify-test-token" });
		assert.equal(child.status, 0, child.stderr);
		const { captured, result } = JSON.parse(child.stdout.trim());
		assert.equal(captured.url, SEARCH_URL, "the token must travel in the header, never the URL");
		assert.equal(captured.method, "POST");
		assert.equal(captured.headers.Authorization, "Bearer apify-test-token");
		assert.equal(captured.headers["User-Agent"], "pi-web-access");
		assert.equal(captured.body.query, "web query");
		assert.equal(captured.body.maxResults, 5);
		assert.deepEqual(captured.body.allowedDomains, ["example.com"]);
		assert.deepEqual(captured.body.blockedDomains, ["private.docs.example.com"]);
		assert.match(captured.body.dateFrom, /^\d{4}-\d{2}-\d{2}$/);
		const ageDays = (Date.now() - Date.parse(captured.body.dateFrom)) / 86_400_000;
		assert.ok(ageDays > 6 && ageDays < 9, `dateFrom should be about a week ago, got ${captured.body.dateFrom}`);
		assert.deepEqual(result.results, [
			{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" },
			{ title: "Source 2", url: "https://docs.example.com/e", snippet: "" },
		]);
	});
});

test("Apify Web Search trims results, omits unused filters, and reads the token from web-search.json", async () => {
	await withHome({ apifyApiKey: "configured-token" }, async (home) => {
		const child = runChild(`
			let auth, body;
			globalThis.fetch = async (_url, init) => {
				auth = init.headers.Authorization;
				body = JSON.parse(init.body);
				return new Response(${JSON.stringify(searchReply([
					{ url: "https://example.com/1", title: "One", snippet: "1" },
					{ url: "https://example.com/2", title: "Two", snippet: "2" },
					{ url: "https://example.com/3", title: "Three", snippet: "3" },
				]))});
			};
			const { searchWithApify, isApifyAvailable } = await import(${JSON.stringify(moduleUrl)});
			const result = await searchWithApify("q", { numResults: 2 });
			console.log(JSON.stringify({ auth, body, available: isApifyAvailable(), urls: result.results.map(r => r.url) }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), {
			auth: "Bearer configured-token",
			body: { query: "q", maxResults: 2 },
			available: true,
			urls: ["https://example.com/1", "https://example.com/2"],
		});
	});
});

test("Apify is unavailable without a token and explains how to set one", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			globalThis.fetch = async () => { throw new Error("must not be called"); };
			const { searchWithApify, extractWithApify, isApifyAvailable } = await import(${JSON.stringify(moduleUrl)});
			const messages = [];
			for (const call of [() => searchWithApify("q"), () => extractWithApify("https://example.com/p")]) {
				try { await call(); messages.push(""); } catch (err) { messages.push(err.message); }
			}
			console.log(JSON.stringify({ available: isApifyAvailable(), messages }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const out = JSON.parse(child.stdout.trim());
		assert.equal(out.available, false);
		for (const message of out.messages) {
			assert.match(message, /apifyApiKey/);
			assert.match(message, /APIFY_TOKEN/);
		}
	});
});

test("Apify Web Search reports both error envelopes, redacts the token, and rejects malformed replies", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const { searchWithApify } = await import(${JSON.stringify(moduleUrl)});
			const outcomes = [];
			for (const make of [
				() => new Response(JSON.stringify({ error: { type: "token-not-valid", message: "Bad token apify-secret-token" } }), { status: 401 }),
				() => new Response(JSON.stringify({ code: "INVALID_INPUT", error: "query is required" }), { status: 400 }),
				() => new Response("upstream down apify-secret-token", { status: 502 }),
				() => new Response("not json", { status: 200 }),
				() => new Response(JSON.stringify({ nothing: true }), { status: 200 }),
			]) {
				globalThis.fetch = async () => make();
				try { await searchWithApify("q"); outcomes.push("ok"); } catch (err) { outcomes.push(err.message); }
			}
			console.log(JSON.stringify(outcomes));
		`, { PI_CODING_AGENT_DIR: home, APIFY_TOKEN: "apify-secret-token" });
		assert.equal(child.status, 0, child.stderr);
		const [unauthorized, invalidInput, rawText, notJson, noResults] = JSON.parse(child.stdout.trim());
		assert.match(unauthorized, /Apify Web Search error 401: token-not-valid: Bad token/);
		assert.match(invalidInput, /Apify Web Search error 400: INVALID_INPUT: query is required/);
		assert.match(rawText, /Apify Web Search error 502: upstream down/);
		for (const message of [unauthorized, rawText]) assert.ok(!message.includes("apify-secret-token"), message);
		assert.match(notJson, /invalid JSON/);
		assert.match(noResults, /expected results array/);
	});
});

test("Apify Web Search drops the credential when a redirect leaves the API origin", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const seen = [];
			globalThis.fetch = async (url, init) => {
				seen.push({ url: String(url), auth: new Headers(init.headers).get("Authorization") });
				if (seen.length === 1) return new Response(null, { status: 307, headers: { location: "https://other.example.net/" } });
				return new Response(${JSON.stringify(searchReply([]))}, { status: 200 });
			};
			const { searchWithApify } = await import(${JSON.stringify(moduleUrl)});
			await searchWithApify("q");
			console.log(JSON.stringify(seen));
		`, { PI_CODING_AGENT_DIR: home, APIFY_TOKEN: "apify-test-token" });
		assert.equal(child.status, 0, child.stderr);
		const seen = JSON.parse(child.stdout.trim());
		assert.equal(seen[0].auth, "Bearer apify-test-token");
		assert.equal(seen[1].auth, null);
	});
});

test("Apify Web Fetch posts the URL and returns the page as Markdown", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const calls = [];
			const replies = [${JSON.stringify(fetchReply(" # Heading\n\nBody "))}, ${JSON.stringify(fetchReply("   "))}, ${JSON.stringify(fetchReply(undefined))}];
			globalThis.fetch = async (url, init) => {
				calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
				return new Response(replies[calls.length - 1], { status: 200 });
			};
			const { extractWithApify } = await import(${JSON.stringify(moduleUrl)});
			const results = [];
			for (let i = 0; i < 3; i++) results.push(await extractWithApify("https://example.com/page"));
			console.log(JSON.stringify({ call: calls[0], results }));
		`, { PI_CODING_AGENT_DIR: home, APIFY_TOKEN: "apify-test-token" });
		assert.equal(child.status, 0, child.stderr);
		const { call, results } = JSON.parse(child.stdout.trim());
		assert.equal(call.url, FETCH_URL);
		assert.equal(call.method, "POST");
		assert.equal(call.auth, "Bearer apify-test-token");
		assert.deepEqual(call.body, { url: "https://example.com/page", formats: ["markdown"] });
		assert.deepEqual(results[0], { url: "https://example.com/page", title: "Page", content: "# Heading\n\nBody", error: null, status: 200 });
		assert.equal(results[1], null);
		assert.equal(results[2], null);
	});
});

test("Apify Web Fetch throws for an unreachable page and for an HTTP error without leaking the token", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const { extractWithApify } = await import(${JSON.stringify(moduleUrl)});
			const outcomes = [];
			for (const make of [
				() => new Response(JSON.stringify({ code: "UPSTREAM_FETCH_ERROR", error: "Failed to fetch \\"https://example.com/p\\"." }), { status: 502 }),
				() => new Response("denied apify-secret-token", { status: 403 }),
			]) {
				globalThis.fetch = async () => make();
				try { await extractWithApify("https://example.com/p"); outcomes.push("ok"); } catch (err) { outcomes.push(err.message); }
			}
			console.log(JSON.stringify(outcomes));
		`, { PI_CODING_AGENT_DIR: home, APIFY_TOKEN: "apify-secret-token" });
		assert.equal(child.status, 0, child.stderr);
		const [unreachable, denied] = JSON.parse(child.stdout.trim());
		assert.match(unreachable, /Apify Web Fetch error 502: UPSTREAM_FETCH_ERROR: Failed to fetch/);
		assert.match(denied, /Apify Web Fetch error 403/);
		assert.ok(!denied.includes("apify-secret-token"));
	});
});

test("Apify honors apifySearchBaseUrl and apifyFetchBaseUrl independently", async () => {
	await withHome({ apifyApiKey: "apify-test-token", apifySearchBaseUrl: "https://gateway.example.com/search", apifyFetchBaseUrl: "https://gateway.example.com/fetch" }, async (home) => {
		const child = runChild(`
			const urls = [];
			globalThis.fetch = async (url) => {
				urls.push(String(url));
				return new Response(urls.length === 1 ? ${JSON.stringify(searchReply([]))} : ${JSON.stringify(fetchReply("hi"))}, { status: 200 });
			};
			const { searchWithApify, extractWithApify } = await import(${JSON.stringify(moduleUrl)});
			await searchWithApify("q");
			await extractWithApify("https://example.com/p");
			console.log(JSON.stringify(urls));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), ["https://gateway.example.com/search/", "https://gateway.example.com/fetch/"]);
	});
});

test("Apify is a named search provider and fetch route that auto and all never pick", async () => {
	const child = runChild(`
		const { ALL_SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS } = await import(${JSON.stringify(new URL("../gemini-search.ts", import.meta.url).href)});
		console.log(JSON.stringify({ resolved: RESOLVED_SEARCH_PROVIDERS.includes("apify"), inAll: ALL_SEARCH_PROVIDERS.includes("apify") }));
	`);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { resolved: true, inAll: false });
});
