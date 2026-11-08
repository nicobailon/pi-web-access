import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../specstream.ts", import.meta.url).href;
const SEARCH_URL = "https://api.specstream.ai/v1/web-search";
const EXTRACT_URL = "https://api.specstream.ai/v1/extract";

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-specstream-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (/_API_KEY$|_BASE_URL$|^SERPAPI_KEY$|^SERPER_API_KEY$/.test(key)) delete childEnv[key];
	}
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
}

const sources = entries => JSON.stringify({ request_id: "r1", status: 200, data: { query: "q", sources: entries }, error: null });
const extracted = entry => JSON.stringify({ request_id: "r1", status: 200, data: { results: [entry] }, error: null });

async function withHome(config, fn) {
	const home = await createHome(config);
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("SpecStream maps sources, applies domain filters locally, and keeps the key in the header", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			let captured;
			globalThis.fetch = async (url, init) => {
				captured = { url: String(url), method: init.method, headers: { ...init.headers } };
				return new Response(${JSON.stringify(sources([
					{ url: "https://docs.example.com/a", title: "Allowed", site: "docs.example.com", snippet: "result" },
					{ url: "https://private.docs.example.com/b", title: "Excluded", snippet: "private" },
					{ url: "https://example.net/c", title: "Outside", snippet: "outside" },
					{ url: "ftp://docs.example.com/d", title: "Not http", snippet: "ftp" },
					{ url: "https://docs.example.com/e", title: " ", snippet: null },
				]))}, { status: 200 });
			};
			const { searchWithSpecStream } = await import(${JSON.stringify(moduleUrl)});
			const result = await searchWithSpecStream("web query", { numResults: 5, domainFilter: ["example.com", "-private.docs.example.com"] });
			console.log(JSON.stringify({ captured, result }));
		`, { PI_CODING_AGENT_DIR: home, SPECSTREAM_API_KEY: "specstream-test-key" });
		assert.equal(child.status, 0, child.stderr);
		const { captured, result } = JSON.parse(child.stdout.trim());
		assert.equal(captured.url, `${SEARCH_URL}?q=web+query`, "the key must travel in the header, never the query string");
		assert.equal(captured.method, "GET");
		assert.equal(captured.headers.Authorization, "Bearer specstream-test-key");
		assert.equal(captured.headers["User-Agent"], "pi-web-access");
		assert.deepEqual(result.results, [
			{ title: "Allowed", url: "https://docs.example.com/a", snippet: "result" },
			{ title: "Source 2", url: "https://docs.example.com/e", snippet: "" },
		]);
	});
});

test("SpecStream trims results to numResults and reads the key from web-search.json", async () => {
	await withHome({ specstreamApiKey: "configured-key" }, async (home) => {
		const child = runChild(`
			let auth;
			globalThis.fetch = async (_url, init) => {
				auth = init.headers.Authorization;
				return new Response(${JSON.stringify(sources([
					{ url: "https://example.com/1", title: "One", snippet: "1" },
					{ url: "https://example.com/2", title: "Two", snippet: "2" },
					{ url: "https://example.com/3", title: "Three", snippet: "3" },
				]))});
			};
			const { searchWithSpecStream, isSpecStreamAvailable } = await import(${JSON.stringify(moduleUrl)});
			const result = await searchWithSpecStream("q", { numResults: 2 });
			console.log(JSON.stringify({ auth, available: isSpecStreamAvailable(), urls: result.results.map(r => r.url) }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), {
			auth: "Bearer configured-key",
			available: true,
			urls: ["https://example.com/1", "https://example.com/2"],
		});
	});
});

test("SpecStream is unavailable without a key and explains how to set one", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			globalThis.fetch = async () => { throw new Error("must not be called"); };
			const { searchWithSpecStream, isSpecStreamAvailable } = await import(${JSON.stringify(moduleUrl)});
			let message = "";
			try { await searchWithSpecStream("q"); } catch (err) { message = err.message; }
			console.log(JSON.stringify({ available: isSpecStreamAvailable(), message }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const out = JSON.parse(child.stdout.trim());
		assert.equal(out.available, false);
		assert.match(out.message, /specstreamApiKey/);
		assert.match(out.message, /SPECSTREAM_API_KEY/);
	});
});

test("SpecStream redacts the key from error bodies and rejects malformed replies", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const { searchWithSpecStream } = await import(${JSON.stringify(moduleUrl)});
			const outcomes = [];
			for (const make of [
				() => new Response("bad key specstream-secret-key", { status: 401 }),
				() => new Response("not json", { status: 200 }),
				() => new Response(JSON.stringify({ nothing: true }), { status: 200 }),
				() => new Response(JSON.stringify({ data: null, error: { message: "Query is empty." } }), { status: 200 }),
				() => new Response(JSON.stringify({ sources: [{ url: "https://a.example/", title: "A" }] }), { status: 200 }),
			]) {
				globalThis.fetch = async () => make();
				try { await searchWithSpecStream("q"); outcomes.push("ok"); } catch (err) { outcomes.push(err.message); }
			}
			console.log(JSON.stringify(outcomes));
		`, { PI_CODING_AGENT_DIR: home, SPECSTREAM_API_KEY: "specstream-secret-key" });
		assert.equal(child.status, 0, child.stderr);
		const [unauthorized, notJson, noSources, nullData, unwrapped] = JSON.parse(child.stdout.trim());
		assert.match(unauthorized, /SpecStream error 401/);
		assert.ok(!unauthorized.includes("specstream-secret-key"));
		assert.match(notJson, /invalid JSON/);
		assert.match(noSources, /expected sources array/);
		assert.match(nullData, /Query is empty/);
		assert.equal(unwrapped, "ok");
	});
});

test("SpecStream search drops the credential when a redirect leaves the API origin", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const seen = [];
			globalThis.fetch = async (url, init) => {
				seen.push({ url: String(url), auth: new Headers(init.headers).get("Authorization") });
				if (seen.length === 1) return new Response(null, { status: 307, headers: { location: "https://other.example.net/v1/web-search" } });
				return new Response(${JSON.stringify(sources([]))}, { status: 200 });
			};
			const { searchWithSpecStream } = await import(${JSON.stringify(moduleUrl)});
			await searchWithSpecStream("q");
			console.log(JSON.stringify(seen));
		`, { PI_CODING_AGENT_DIR: home, SPECSTREAM_API_KEY: "specstream-test-key" });
		assert.equal(child.status, 0, child.stderr);
		const seen = JSON.parse(child.stdout.trim());
		assert.equal(seen[0].auth, "Bearer specstream-test-key");
		assert.equal(seen[1].auth, null);
	});
});

test("SpecStream Extract posts the URL and returns the page as Markdown", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const calls = [];
			const replies = [
				{ url: "https://example.com/page", status: "ok", title: " Page ", text: " # Heading\\n\\nBody " },
				{ url: "https://example.com/page", status: "empty", text: "" },
				{ url: "https://example.com/page", status: "unsupported" },
			];
			globalThis.fetch = async (url, init) => {
				calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
				return new Response(JSON.stringify({ data: { results: [replies[calls.length - 1]] }, error: null }), { status: 200 });
			};
			const { extractWithSpecStream } = await import(${JSON.stringify(moduleUrl)});
			const results = [];
			for (let i = 0; i < 3; i++) results.push(await extractWithSpecStream("https://example.com/page"));
			console.log(JSON.stringify({ call: calls[0], results }));
		`, { PI_CODING_AGENT_DIR: home, SPECSTREAM_API_KEY: "specstream-test-key" });
		assert.equal(child.status, 0, child.stderr);
		const { call, results } = JSON.parse(child.stdout.trim());
		assert.equal(call.url, EXTRACT_URL);
		assert.equal(call.method, "POST");
		assert.equal(call.auth, "Bearer specstream-test-key");
		assert.deepEqual(call.body, { urls: ["https://example.com/page"], format: "markdown" });
		assert.deepEqual(results[0], { url: "https://example.com/page", title: "Page", content: "# Heading\n\nBody", error: null });
		assert.equal(results[1], null);
		assert.equal(results[2], null);
	});
});

test("SpecStream Extract throws for a failed page and for an HTTP error without leaking the key", async () => {
	await withHome({}, async (home) => {
		const child = runChild(`
			const { extractWithSpecStream } = await import(${JSON.stringify(moduleUrl)});
			const outcomes = [];
			for (const make of [
				() => new Response(${JSON.stringify(extracted({ url: "https://example.com/p", status: "failed" }))}, { status: 200 }),
				() => new Response("denied specstream-secret-key", { status: 403 }),
			]) {
				globalThis.fetch = async () => make();
				try { await extractWithSpecStream("https://example.com/p"); outcomes.push("ok"); } catch (err) { outcomes.push(err.message); }
			}
			console.log(JSON.stringify(outcomes));
		`, { PI_CODING_AGENT_DIR: home, SPECSTREAM_API_KEY: "specstream-secret-key" });
		assert.equal(child.status, 0, child.stderr);
		const [failed, denied] = JSON.parse(child.stdout.trim());
		assert.match(failed, /could not read the page: failed/);
		assert.match(denied, /SpecStream Extract error 403/);
		assert.ok(!denied.includes("specstream-secret-key"));
	});
});

test("SpecStream honors specstreamBaseUrl for both endpoints", async () => {
	await withHome({ specstreamApiKey: "specstream-test-key", specstreamBaseUrl: "https://gateway.example.com/proxy" }, async (home) => {
		const child = runChild(`
			const urls = [];
			globalThis.fetch = async (url) => {
				urls.push(String(url));
				return new Response(urls.length === 1 ? ${JSON.stringify(sources([]))} : ${JSON.stringify(extracted({ url: "https://example.com/p", status: "ok", text: "hi" }))}, { status: 200 });
			};
			const { searchWithSpecStream, extractWithSpecStream } = await import(${JSON.stringify(moduleUrl)});
			await searchWithSpecStream("q");
			await extractWithSpecStream("https://example.com/p");
			console.log(JSON.stringify(urls));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const [searchUrl, extractUrl] = JSON.parse(child.stdout.trim());
		assert.ok(searchUrl.startsWith("https://gateway.example.com/proxy/v1/web-search"), searchUrl);
		assert.equal(extractUrl, "https://gateway.example.com/proxy/v1/extract");
	});
});
