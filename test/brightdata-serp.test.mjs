import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const brightdataModuleUrl = new URL("../brightdata.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const activityModuleUrl = new URL("../activity.ts", import.meta.url).href;

// Every child starts from a config-less HOME. Deleting PI_CODING_AGENT_DIR and
// XDG_CONFIG_HOME is not enough: getWebSearchConfigDir() then falls through to
// join(homedir(), ".pi"), i.e. the developer's real ~/.pi/web-search.json — which is
// exactly the file the README tells a reviewer to create. Without this, a maintainer
// with brightdataApiKey configured sees unrelated failures, and if that key is a
// `!command` source (`!op read …`, `!pass show …`) their secret manager is invoked by
// `npm test`. Tests that need a config point PI_CODING_AGENT_DIR at a temp dir; the
// two variables below only decide where "no config at all" resolves to.
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "pi-web-access-brightdata-empty-"));

function runChild(script, env = {}) {
	const childEnv = { ...process.env, HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE",
		"OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "TAVILY_API_KEY",
		"JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "ANYSEARCH_API_KEY", "SEARXNG_BASE_URL", "EXA_API_KEY", "PERPLEXITY_API_KEY",
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

async function createHome(config) {
	return createRawHome(JSON.stringify(config) + "\n");
}

// A config file that is not valid JSON cannot be produced by createHome().
async function createRawHome(text) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brightdata-"));
	await writeFile(join(home, "web-search.json"), text, "utf8");
	return home;
}

// The parsed_light SERP envelope: ranked links only, no page bodies. The third
// entry is on a host the domain-filter tests exclude, the fourth has no link at
// all — a real Google SERP contains such entries and they must be skipped, not
// throw away a page of results that was already billed.
function serpBody() {
	return JSON.stringify({
		organic: [
			{ link: "https://github.com/nicobailon/pi-web-access", title: "Repo", description: "repo   description" },
			{ link: "https://gist.github.com/nicobailon/abc", title: "Gist", description: "gist description" },
			{ link: "https://example.com/nope", title: "Example", description: "example description" },
			{ title: "Sponsored", description: "no link" },
		],
	});
}

function probe(extra = "") {
	return `
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = Object.fromEntries(new Headers(init.headers));
			capturedBody = JSON.parse(init.body);
			return new Response(${JSON.stringify(serpBody())}, { status: 200, headers: { "content-type": "application/json" } });
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		${extra}
	`;
}

test("the SERP request carries the configured zone, the parsed_light format, and brd_json=1", async () => {
	const child = runChild(probe(`
		const result = await searchWithBrightData("vector databases", { numResults: 3 });
		const url = new URL(capturedBody.url);
		console.log(JSON.stringify({
			endpoint: capturedUrl,
			auth: capturedHeaders.authorization,
			body: capturedBody,
			serp: { host: url.host, path: url.pathname, params: Object.fromEntries(url.searchParams) },
			result,
		}));
	`), { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.endpoint, "https://api.brightdata.com/request");
	assert.equal(output.auth, "Bearer bd-test-key");
	assert.equal(output.body.zone, "pi_serp");
	assert.equal(output.body.format, "raw");
	// parsed_light is what turns the proxied SERP into { organic: [...] }.
	assert.equal(output.body.data_format, "parsed_light");
	assert.equal(output.serp.host, "www.google.com");
	assert.equal(output.serp.path, "/search");
	assert.equal(output.serp.params.q, "vector databases");
	// Without brd_json=1 Bright Data returns Google's HTML and data_format has
	// nothing to parse — this is the parameter the whole surface depends on.
	assert.equal(output.serp.params.brd_json, "1");
	assert.equal(output.serp.params.tbs, undefined);

	// Organic entries map to SearchResult, whitespace-collapsed, link-less
	// entries skipped, and the answer is assembled from the sources.
	assert.deepEqual(output.result.results, [
		{ title: "Repo", url: "https://github.com/nicobailon/pi-web-access", snippet: "repo description" },
		{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", snippet: "gist description" },
		{ title: "Example", url: "https://example.com/nope", snippet: "example description" },
	]);
	assert.match(output.result.answer, /repo description\nSource: Repo \(https:\/\/github\.com\/nicobailon\/pi-web-access\)/);
});

test("a SERP zone returns no page bodies, so includeContent never produces inline content", async () => {
	const child = runChild(probe(`
		const result = await searchWithBrightData("vector databases", { includeContent: true });
		console.log(JSON.stringify({ keys: Object.keys(result), inlineContent: result.inlineContent ?? null }));
	`), { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.keys, ["answer", "results"]);
	assert.equal(output.inlineContent, null);
});

test("numResults caps the returned results and the SERP page size", async () => {
	const child = runChild(probe(`
		const few = await searchWithBrightData("q", { numResults: 2 });
		const fewNum = new URL(capturedBody.url).searchParams.get("num");
		const many = await searchWithBrightData("q", { numResults: 50 });
		const manyNum = new URL(capturedBody.url).searchParams.get("num");
		const none = await searchWithBrightData("q");
		const noneNum = new URL(capturedBody.url).searchParams.get("num");
		console.log(JSON.stringify({ few: few.results.length, fewNum, many: many.results.length, manyNum, none: none.results.length, noneNum }));
	`), { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.few, 2);
	assert.equal(output.fewNum, "7");        // asked count + headroom for local re-filtering
	assert.equal(output.many, 3);            // clamped to 20, but only 3 usable entries came back
	assert.equal(output.manyNum, "20");      // headroom is capped, one request is billed once
	assert.equal(output.none, 3);
	assert.equal(output.noneNum, "10");      // default 5 + headroom
});

test("recency is Google's own tbs filter, not a query hint and not a body parameter", async () => {
	const child = runChild(probe(`
		const seen = {};
		for (const recencyFilter of ["day", "week", "month", "year"]) {
			await searchWithBrightData("ai news", { recencyFilter });
			const params = new URL(capturedBody.url).searchParams;
			seen[recencyFilter] = { tbs: params.get("tbs"), q: params.get("q") };
		}
		console.log(JSON.stringify({ seen, body: capturedBody }));
	`), { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.seen, {
		day: { tbs: "qdr:d", q: "ai news" },
		week: { tbs: "qdr:w", q: "ai news" },
		month: { tbs: "qdr:m", q: "ai news" },
		year: { tbs: "qdr:y", q: "ai news" },
	});
	// The window is expressed to the engine, never smuggled into the question.
	for (const param of ["recency", "recency_minutes", "time_range", "start_date", "end_date", "days"]) {
		assert.equal(param in output.body, false, `${param} is not part of the Bright Data request body`);
	}
});

test("domain filters are sent to the engine as site: operators and re-applied locally", async () => {
	const child = runChild(probe(`
		const result = await searchWithBrightData("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 5,
		});
		const multi = await searchWithBrightData("sdk docs", { domainFilter: ["github.com", "example.com"] });
		console.log(JSON.stringify({
			q: new URL(capturedBody.url).searchParams.get("q"),
			urls: result.results.map((r) => r.url),
			multiUrls: multi.results.map((r) => r.url),
		}));
	`), { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.q, "sdk docs site:github.com OR site:example.com");
	// site: narrows the SERP; the same filter still runs on what came back, so an
	// excluded subdomain Google returned anyway does not reach the caller.
	assert.deepEqual(output.urls, ["https://github.com/nicobailon/pi-web-access"]);
	assert.deepEqual(output.multiUrls, [
		"https://github.com/nicobailon/pi-web-access",
		"https://gist.github.com/nicobailon/abc",
		"https://example.com/nope",
	]);
});

// Availability checks the configuration this surface actually needs rather than
// merely a key, the way firecrawl.ts's isFirecrawlAvailable() checks its required
// base URL.
test("availability requires both halves of the configuration and never spends to find out", async () => {
	const home = await createHome({ brightdataApiKey: "bd-test-key", brightdataSerpZone: "pi_serp" });
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response(${JSON.stringify(serpBody())}, { status: 200 }); };
		const { isBrightDataAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		console.log(JSON.stringify({ available: isBrightDataAvailable(), fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { available: true, fetchCalls: 0 });

	for (const [label, config] of [
		["key only", { brightdataApiKey: "bd-test-key" }],
		["zone only", { brightdataSerpZone: "pi_serp" }],
		["neither", {}],
	]) {
		const partial = await createHome(config);
		const partialChild = runChild(`
			let fetchCalls = 0;
			globalThis.fetch = async () => { fetchCalls++; return new Response("", { status: 200 }); };
			const { isBrightDataAvailable, searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
			const available = isBrightDataAvailable();
			let error = null;
			try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
			console.log(JSON.stringify({ available, error, fetchCalls }));
		`, { PI_CODING_AGENT_DIR: partial });
		assert.equal(partialChild.status, 0, partialChild.stderr);
		const output = JSON.parse(partialChild.stdout.trim());
		assert.equal(output.available, false, label);
		// A half-finished setup fails loudly and never reaches the billable endpoint.
		assert.equal(output.fetchCalls, 0, label);
		assert.match(
			output.error,
			config.brightdataSerpZone ? /Bright Data API key not found/ : /Bright Data SERP zone is invalid or missing/,
			label,
		);
	}
});

test("a malformed zone is rejected before the request instead of becoming an opaque 400", async () => {
	const home = await createHome({ brightdataApiKey: "bd-test-key", brightdataSerpZone: "https://not-a-zone/" });
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("", { status: 200 }); };
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	// The error names the setting that is wrong, quotes what it found, and says
	// which zone type is required.
	assert.match(output.error, /brightdataSerpZone in .*web-search\.json must be a zone name/);
	assert.match(output.error, /https:\/\/not-a-zone\//);
	assert.match(output.error, /must be of Bright Data type `serp`/);
});

// The reason `normalizeZone` is total and availability cannot throw. Availability
// is evaluated outside its callers' error handling (`gemini-search.ts` checks it
// before the per-provider try/catch; `index.ts` awaits `getProviderAvailability()`
// uncaught on the `web_search` path), so a throw from one mistyped Bright Data
// setting would take web search down for Brave and OpenAI as well.
test("an invalid zone makes Bright Data unavailable, never fatal for the other providers", async () => {
	const home = await createHome({
		brightdataApiKey: "bd-test-key",
		searchRouting: { providers: ["brightdata", "brave"], fallbackOn: ["transient"] },
	});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.brightdata.com/")) throw new Error("unreachable: zone was invalid");
			return new Response(JSON.stringify({ web: { results: [{ title: "brave", url: "https://example.com/brave", description: "ok" }] } }), { status: 200 });
		};
		const { isBrightDataAvailable, searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let available = null;
		let availabilityError = null;
		try { available = isBrightDataAvailable(); } catch (err) { availabilityError = err.message; }
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let routed = null;
		let searchError = null;
		try { routed = (await search("q", { provider: "auto" })).provider; } catch (err) { searchError = String(err); }
		let requestError = null;
		try { await searchWithBrightData("q"); } catch (err) { requestError = err.message; }
		console.log(JSON.stringify({ available, availabilityError, routed, searchError, requestError, calls }));
	`, { PI_CODING_AGENT_DIR: home, BRIGHTDATA_SERP_ZONE: "pi serp", BRAVE_API_KEY: "brave-key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// A predicate, not a diagnostic: it answers false and does not throw.
	assert.equal(output.availabilityError, null);
	assert.equal(output.available, false);
	// And the routed search still gets an answer from the next provider.
	assert.equal(output.searchError, null);
	assert.equal(output.routed, "brave");
	assert.ok(output.calls.every((url) => !url.startsWith("https://api.brightdata.com/")), "the invalid zone never reached the paid endpoint");
	// The request path is where the mistake is reported, in full.
	assert.match(output.requestError, /Bright Data SERP zone is invalid: BRIGHTDATA_SERP_ZONE must be a zone name/);
	assert.match(output.requestError, /pi serp/);
});

// A SERP zone and an Unlocker zone are different Bright Data zone types at
// different prices, and an Unlocker zone does not return SERP JSON. Substituting
// one for the other buys a confusing paid failure, so this surface does not read
// the Unlocker setting at all.
test("an Unlocker zone is never substituted for a missing SERP zone", async () => {
	const home = await createHome({ brightdataApiKey: "bd-test-key", brightdataUnlockerZone: "pi_unlocker" });
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response(${JSON.stringify(serpBody())}, { status: 200 }); };
		const { isBrightDataAvailable, searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const available = isBrightDataAvailable();
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ available, error, fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home, BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker_env" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false, "an Unlocker zone does not make the SERP surface available");
	assert.equal(output.fetchCalls, 0, "no billable request is made against a zone of the wrong type");
	assert.match(output.error, /Bright Data SERP zone is invalid or missing/);
	assert.doesNotMatch(output.error, /pi_unlocker/);
});

test("an HTTP error surfaces the status and never leaks the key", async () => {
	const home = await createHome({ brightdataApiKey: "bd-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(
			JSON.stringify({ error: "unauthorized", message: "token bd-secret is not valid for this zone" }),
			{ status: 401 },
		);
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		let results = null;
		try { const result = await searchWithBrightData("q"); results = result.results; }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, results }));
	`, { PI_CODING_AGENT_DIR: home, BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// A paid failure throws. It never degrades into an empty result set that
	// looks like "the web had no answer".
	assert.equal(output.results, null);
	// The status has to be in the message: gemini-search.ts classifies routing
	// failures by reading it back out of the text.
	assert.match(output.error, /Bright Data API error 401/);
	assert.match(output.error, /unauthorized/);
	assert.match(output.error, /\[redacted\]/);
	assert.doesNotMatch(output.error, /bd-secret/);
});

test("a billed 200 that is not SERP JSON fails loudly and quotes what came back", async () => {
	const child = runChild(`
		const errors = [];
		const bodies = [
			"<!DOCTYPE html><title>Our systems have detected unusual traffic</title>",
			"",
			JSON.stringify([{ link: "https://example.com/" }]),
			JSON.stringify({ organic: "not-an-array" }),
			JSON.stringify({ organic: ["https://example.com/"] }),
			// JSON, HTTP 200, billed — and Bright Data's own error envelope rather
			// than a SERP. This is the shape that used to become { answer: "", results: [] }.
			JSON.stringify({ error: "zone not found", code: "zone_missing" }),
			JSON.stringify({ errors: [{ message: "bad zone type" }] }),
			// A well-formed JSON envelope with no organic array at all: nothing to
			// read, so nothing was bought, and it must not read as "no results".
			JSON.stringify({ status: "ok", general: { search_engine: "google" } }),
		];
		let index = 0;
		globalThis.fetch = async () => new Response(bodies[index++], { status: 200 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		for (let i = 0; i < bodies.length; i++) {
			try { const result = await searchWithBrightData("q"); errors.push({ returned: result }); }
			catch (err) { errors.push(err.message); }
		}
		console.log(JSON.stringify({ errors }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const errors = JSON.parse(child.stdout.trim()).errors;
	assert.equal(errors.length, 8);
	// Nothing returned a value: every one of these was a paid request that cannot
	// be read, and none of them may be reported as an empty result set.
	for (const [index, error] of errors.entries()) {
		assert.equal(typeof error, "string", `body ${index} returned instead of throwing: ${JSON.stringify(error)}`);
	}
	assert.match(errors[0], /Bright Data API returned invalid JSON for zone pi_serp:/);
	// The upstream body is quoted: a bare "Unexpected token <" hides the fact
	// that Google served an interstitial and the request was still billed.
	assert.match(errors[0], /unusual traffic/);
	assert.match(errors[1], /Bright Data API returned empty response for zone pi_serp/);
	assert.match(errors[2], /Bright Data API returned invalid response for zone pi_serp: expected an object envelope/);
	assert.match(errors[3], /Bright Data API returned invalid response for zone pi_serp: expected organic array/);
	assert.match(errors[4], /Bright Data API returned invalid response for zone pi_serp: expected organic\[0\] object/);
	// The billed error envelope: the reported message repeats what Bright Data
	// said and the code it said it with, so the user can act on it.
	assert.match(errors[5], /Bright Data API returned invalid response for zone pi_serp: Bright Data reported an error instead of a SERP/);
	assert.match(errors[5], /zone not found/);
	assert.match(errors[5], /code zone_missing/);
	assert.match(errors[6], /Bright Data reported an error instead of a SERP/);
	assert.match(errors[6], /bad zone type/);
	// The missing-organic envelope names the likeliest cause: the wrong zone type.
	assert.match(errors[7], /expected an organic array and the envelope carried none/);
	assert.match(errors[7], /`unblocker`/);
});

// gemini-search.ts reads a status back out of our error text to decide whether a
// failure is retryable. Upstream text is quoted into that same message, so a
// proxied page that merely mentions a 5xx must not be able to forge our status:
// a billed 200 is not a transient failure, and silently re-running the query on
// the next provider hides the charge.
test("a quoted upstream body cannot forge our HTTP status for routing", async () => {
	const home = await createHome({
		brightdataApiKey: "bd-test-key",
		brightdataSerpZone: "pi_serp",
		searchRouting: { providers: ["brightdata", "brave"], fallbackOn: ["transient"] },
	});
	// Four injection points, not one. The first hides the status line inside a non-JSON
	// body; the second puts it at the very start, where JSON.parse quotes it back inside
	// its own message; the third is Bright Data's own JSON error envelope, which is
	// quoted by a different code path with its own cap; the fourth is that envelope's
	// `errors` spelling.
	for (const body of [
		"<!DOCTYPE html><p>Error 503 from the proxied page</p>",
		"HTTP 503 from the proxied page",
		JSON.stringify({ error: "Error 503 from the proxied page", code: "upstream_failed" }),
		JSON.stringify({ errors: "status: 503 from the proxied page" }),
	]) {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				if (String(url) === "https://api.brightdata.com/request") return new Response(${JSON.stringify(body)}, { status: 200 });
				return new Response(JSON.stringify({ web: { results: [{ title: "brave", url: "https://example.com/brave", description: "ok" }] } }), { status: 200 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			try { const result = await search("forged", { provider: "auto" }); console.log(JSON.stringify({ ok: true, provider: result.provider, calls })); }
			catch (err) { console.log(JSON.stringify({ ok: false, error: String(err), calls })); }
		`, { PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "brave-key" });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		// Classified on what actually happened — an unreadable response — which is
		// not in fallbackOn, so the failure is reported instead of retried.
		assert.equal(output.ok, false, body);
		assert.match(output.error, /brightdata search failed \(invalid-response\)/, body);
		assert.deepEqual(output.calls, ["https://api.brightdata.com/request"], body);
		// The number survives, attributed to the upstream rather than to us.
		assert.match(output.error, /upstream 503/, body);
		assert.doesNotMatch(output.error, /(?:error|status|http)[\s]+503/i, body);
	}
});

// The test above only reaches two of the four places upstream text is quoted, and it
// only uses bodies whose status phrase the sanitiser can already see. Two harder cases:
//
//  - STATUS_SHAPED_PATTERN requires `(\d{3})\b`, so `error 5031` is correctly left
//    alone — but if the length cap were applied *after* the rewrite, the cut would drop
//    the 4th digit and re-create `error 503` in the final message. Each body below is
//    padded so the cut lands exactly there, for each cap in the module (300, 200, 60).
//  - Bright Data's own JSON error envelope is a third injection point, with its own
//    200-character cap, which the test above never exercises.
//
// Both must classify on what actually happened, so a billed 200 is reported rather than
// silently re-run on Brave.
test("truncating a quoted body cannot re-create a status the sanitiser left alone", async () => {
	const home = await createHome({
		brightdataApiKey: "bd-test-key",
		brightdataSerpZone: "pi_serp",
		searchRouting: { providers: ["brightdata", "brave"], fallbackOn: ["transient"] },
	});
	const cases = [
		{
			label: "non-JSON body padded to the 300-char cut",
			body: ".".repeat(291) + "error 5031",
			status: 200,
			kind: "invalid-response",
		},
		{
			label: "Bright Data error envelope padded to the 200-char cut",
			body: JSON.stringify({ error: ".".repeat(191) + "error 5031" }),
			status: 200,
			kind: "invalid-response",
		},
	];
	for (const { label, body, status, kind } of cases) {
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				if (String(url) === "https://api.brightdata.com/request") return new Response(${JSON.stringify(body)}, { status: ${status} });
				return new Response(JSON.stringify({ web: { results: [{ title: "brave", url: "https://example.com/brave", description: "ok" }] } }), { status: 200 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			try { const result = await search("padded", { provider: "auto" }); console.log(JSON.stringify({ ok: true, provider: result.provider, calls })); }
			catch (err) { console.log(JSON.stringify({ ok: false, error: String(err), calls })); }
		`, { PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "brave-key" });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		// The billed 200 is reported. If truncation ran after the rewrite, the message
		// would end `…error 503`, providerErrorStatus would read 503, and `transient`
		// is in fallbackOn — so this would come back ok:true from Brave.
		assert.equal(output.ok, false, label);
		assert.match(output.error, new RegExp(`brightdata search failed \\(${kind}\\)`), label);
		assert.deepEqual(output.calls, ["https://api.brightdata.com/request"], label);
		// The four-digit number is not a status and is not rewritten; what must never
		// appear is a three-digit one the classifier would read.
		assert.doesNotMatch(output.error, /\b(?:error|status|http)[\s:=-]{1,4}503\b/i, label);
	}
});

// The same ordering hazard at the module's two remaining caps: the 300-character
// non-2xx body and the 60-character rejected-zone echo. Neither of these two is a
// routing bypass — the module's own `error <status>` phrase comes first in the non-2xx
// message, and a zone error never reaches classifyProviderError at all (an unusable
// zone makes the provider unavailable, and an explicit provider skips classification)
// — but a fabricated status in a message a human reads is still a defect, and both caps
// have to be proven to sanitise the text that is actually kept.
test("truncation cannot forge a status in a non-2xx message or a rejected-zone echo", async () => {
	const child = runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify(".".repeat(291) + "error 5031")}, { status: 404 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, statuses: error.match(/\\b(?:error|status|http)[\\s:=-]{1,4}\\d{3}\\b/gi) }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// Exactly one status-shaped phrase, and it is the status we actually received.
	assert.deepEqual(output.statuses, ["error 404"]);
	assert.match(output.error, /upstream 503/);

	// 51 dots + "error 5031" is 61 characters: the 60-character cut lands on the 4th
	// digit, so sanitising before truncating would produce "…error 503" here too.
	const zoneChild = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("", { status: 200 }); };
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, fetchCalls, statuses: error.match(/\\b(?:error|status|http)[\\s:=-]{1,4}\\d{3}\\b/gi) }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: ".".repeat(51) + "error 5031" });
	assert.equal(zoneChild.status, 0, zoneChild.stderr);
	const zoneOutput = JSON.parse(zoneChild.stdout.trim());
	assert.equal(zoneOutput.fetchCalls, 0);
	assert.match(zoneOutput.error, /Bright Data SERP zone is invalid: BRIGHTDATA_SERP_ZONE must be a zone name/);
	assert.equal(zoneOutput.statuses, null);
	assert.match(zoneOutput.error, /upstream 503/);
});

test("an empty organic array is a legitimate empty result, not an error", async () => {
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ organic: [] }), { status: 200 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await searchWithBrightData("query with no hits");
		console.log(JSON.stringify(result));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { answer: "", results: [] });
});

test("a malformed config root fails explicitly on the request path and only there", async () => {
	const home = await createHome([]);
	const child = runChild(`
		const { isBrightDataAvailable, searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let available = null;
		let availabilityError = null;
		try { available = isBrightDataAvailable(); } catch (err) { availabilityError = err.message; }
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ available, availabilityError, error }));
	`, { PI_CODING_AGENT_DIR: home, BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /Invalid config in .*web-search\.json: expected a JSON object/);
	// Availability is a predicate on every input, including a config file it
	// cannot read: it is called outside its callers' error handling, so it reports
	// this provider unavailable and lets the request path do the explaining.
	assert.equal(output.availabilityError, null);
	assert.equal(output.available, false);
});

test("aborting propagates instead of returning an empty answer", async () => {
	const child = runChild(`
		// The caller's signal has to reach the request itself, not just be checked
		// once: a stub that throws unconditionally would pass even if the signal
		// were dropped, so the threaded signal is captured and asserted.
		let threaded = null;
		globalThis.fetch = async (_url, init) => {
			threaded = init.signal instanceof AbortSignal ? init.signal.aborted : null;
			throw new Error("The operation was aborted");
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		try { await searchWithBrightData("cancel", { signal: AbortSignal.abort() }); }
		catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, threaded }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.error, /aborted/);
	assert.equal(output.threaded, true);
});

// The key travels through the shared request-time credential-source path. Proven
// with a filesystem marker: nothing runs at module load or during availability,
// and the command resolves once per request so a rotated token is picked up.
test("the key uses the shared credential-source path, resolved at request time", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brightdata-cred-"));
	const agentDir = join(home, "agent");
	await mkdir(agentDir, { recursive: true });
	const marker = join(home, "brightdata-resolver-ran");
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({
			brightdataApiKey: `!touch ${marker} && printf bd-command-key`,
			brightdataSerpZone: "pi_serp",
		}) + "\n",
		"utf8",
	);

	const child = runChild(`
		import { existsSync } from "node:fs";
		const { isBrightDataAvailable, searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const availableBefore = isBrightDataAvailable();
		const ranBefore = existsSync(${JSON.stringify(marker)});
		let auth = null;
		globalThis.fetch = async (url, init) => {
			auth = Object.fromEntries(new Headers(init.headers)).authorization;
			return new Response(JSON.stringify({ organic: [] }), { status: 200 });
		};
		await searchWithBrightData("q", { numResults: 1 });
		console.log(JSON.stringify({ availableBefore, ranBefore, ranAfter: existsSync(${JSON.stringify(marker)}), auth }));
	`, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.availableBefore, true);   // available without running the command
	assert.equal(output.ranBefore, false);        // nothing ran at module load
	assert.equal(output.ranAfter, true);          // resolved at request time
	assert.equal(output.auth, "Bearer bd-command-key");
});

test("explicit brightdata routing reaches the provider and is attributed", async () => {
	const home = await createHome({ brightdataApiKey: "bd-test-key", brightdataSerpZone: "pi_serp" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(${JSON.stringify(serpBody())}, { status: 200 }); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "brightdata" });
		console.log(JSON.stringify({ provider: result.provider, calls, first: result.results[0].url }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		provider: "brightdata",
		calls: ["https://api.brightdata.com/request"],
		first: "https://github.com/nicobailon/pi-web-access",
	});
});

// One test per redaction site is what "the token is passed through redactCredential on
// every body, message and log line" actually means. Before this existed, three of the
// four sites were unasserted and one of them — the JSON.parse message, which quotes the
// response body inside itself — printed the token in cleartext.
test("no error path prints the API token, at any site that quotes foreign text", async () => {
	const token = "bd-plant-1234";
	const child = runChild(`
		const bodies = [
			// non-2xx body
			{ status: 401, body: JSON.stringify({ error: "unauthorized", message: "token ${token} is not valid" }) },
			// A billed 200 that is not JSON: JSON.parse quotes the body inside its own
			// message, so the token reaches the "detail" half as well as the "body" half.
			// Kept under 20 characters on purpose — V8 quotes a short source in full and
			// windows a longer one to its first 10 characters, and it is the full-quote
			// case that printed a usable token.
			{ status: 200, body: "${token} dead" },
			// billed 200 carrying Bright Data's own error envelope
			{ status: 200, body: JSON.stringify({ error: "token ${token} is not valid for this zone", code: "auth_failed" }) },
		];
		let index = 0;
		globalThis.fetch = async () => {
			const next = bodies[index++];
			if (!next) throw new Error("connect ECONNREFUSED while sending token ${token}");
			return new Response(next.body, { status: next.status });
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
		const messages = [];
		for (let i = 0; i < bodies.length + 1; i++) {
			try { await searchWithBrightData("q"); messages.push(null); }
			catch (err) { messages.push(err.message); }
		}
		console.log(JSON.stringify({ messages, logged: activityMonitor.getEntries().map((e) => e.error ?? null) }));
	`, { BRIGHTDATA_API_KEY: token, BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.messages.length, 4);
	const labels = ["non-2xx body", "invalid-JSON parser message and body", "200 error envelope", "transport error"];
	for (const [index, message] of output.messages.entries()) {
		assert.equal(typeof message, "string", `${labels[index]} did not throw`);
		assert.doesNotMatch(message, new RegExp(token), labels[index]);
		assert.match(message, /\[redacted\]/, labels[index]);
	}
	// The parser message and the quoted body are two separate halves of the same
	// message, and both used to be reachable independently — assert both are redacted.
	assert.match(output.messages[1], /^Bright Data API returned invalid JSON for zone pi_serp: \[redacted\] dead$/);
	assert.doesNotMatch(output.messages[1], /Unexpected token/);
	// Every message about a request that was billed names the zone it was billed
	// against. The transport error does not: nothing was billed, and the message is
	// undici's, rethrown with only the credential removed.
	for (const index of [0, 1, 2]) assert.match(output.messages[index], /for zone pi_serp/, labels[index]);
	assert.doesNotMatch(output.messages[3], /pi_serp/);
	// The log line is the fourth place the token could escape.
	for (const logged of output.logged) {
		if (logged !== null) assert.doesNotMatch(logged, new RegExp(token));
	}
	assert.ok(output.logged.some((logged) => logged !== null && logged.includes("[redacted]")), "the transport error was logged, redacted");
});

// A real Bright Data token is long enough that V8 windows it rather than quoting it in
// full, and the window is a *prefix*. `redactCredential` substitutes whole occurrences,
// so a prefix slips past it: quoting the parser message printed the first 10 characters
// of the token in cleartext even with the redaction applied. The module no longer quotes
// that message at all. This asserts the property directly — no prefix of any length
// survives — rather than pinning one string, so it stays honest if the wording changes.
test("no prefix of the credential survives into a message, however the body is shaped", async () => {
	const token = "abcdef12-3456-7890-abcd-ef1234567890";
	const child = runChild(`
		const token = ${JSON.stringify(token)};
		const bodies = [
			token + " is expired, contact support",
			JSON.stringify({ error: token + " is not valid for this zone" }),
			"{ \\"organic\\": [ " + token,
			token,
		];
		let index = 0;
		globalThis.fetch = async () => new Response(bodies[index++], { status: 200 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const messages = [];
		for (let i = 0; i < bodies.length; i++) {
			try { await searchWithBrightData("q"); messages.push(null); }
			catch (err) { messages.push(err.message); }
		}
		console.log(JSON.stringify({ messages }));
	`, { BRIGHTDATA_API_KEY: token, BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const { messages } = JSON.parse(child.stdout.trim());
	assert.equal(messages.length, 4);
	for (const [index, message] of messages.entries()) {
		assert.equal(typeof message, "string", `body ${index} did not throw`);
		// Four characters is already enough to be worth withholding, and testing every
		// length from there up means a future change cannot leak a longer prefix quietly.
		for (let length = 4; length <= token.length; length++) {
			assert.doesNotMatch(message, new RegExp(token.slice(0, length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				`body ${index} leaked a ${length}-character prefix: ${message}`);
		}
	}
});

// `gemini-search.ts` classifies a provider failure by matching keyword phrases against
// our message, and `searchRouting.fallbackOn` accepts transient, quota and network. Of
// those, only the quota branch runs before the invalid-response branch this module's
// wording triggers — so an upstream page that merely says "rate limit" could make a
// BILLED 200 look like a quota failure, and be silently retried on the next provider
// with no diagnostic. That is the exact outcome this module exists to prevent, so the
// classifier's ordering assumption is pinned here rather than trusted.
test("a billed 200 quoting rate-limit text cannot classify as a silently-retryable failure", async () => {
	// Transcribed from origin/main gemini-search.ts classifyProviderError, in order.
	const classify = (message) => {
		const lower = message.toLowerCase();
		const status = (message.match(/\b(?:error|status|http)\s+(\d{3})\b/i) ?? [])[1];
		const code = status === undefined ? undefined : Number(status);
		if (/(?:api )?key (?:not found|missing)|credential resolution/.test(lower)) return "credential";
		if (code === 401 || code === 403) return "auth";
		if (code === 400 || code === 422) return "invalid-request";
		if (code === 402 || code === 429) return "quota";
		if (code !== undefined && (code === 408 || code === 425 || code >= 500)) return "transient";
		if (/rate limit|quota|too many requests/.test(lower)) return "quota";
		if (/unauthorized|forbidden|permission denied/.test(lower)) return "auth";
		if (/bad request|invalid request/.test(lower)) return "invalid-request";
		if (/invalid json|no parseable response|returned invalid response|returned empty response/.test(lower)) return "invalid-response";
		if (/temporar|service unavailable|server error/.test(lower)) return "transient";
		if (/fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(lower)) return "network";
		return "unknown";
	};

	const child = runChild(`
		const bodies = [
			"<html>You have exceeded your rate limit for this zone.</html>",
			JSON.stringify({ error: "too many requests for this zone" }),
			JSON.stringify({ error: "quota exhausted" }),
			"<html>Service Unavailable - server error</html>",
			"<html>socket timed out, network unreachable</html>",
		];
		let index = 0;
		globalThis.fetch = async () => new Response(bodies[index++], { status: 200 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const messages = [];
		for (let i = 0; i < bodies.length; i++) {
			try { await searchWithBrightData("q"); messages.push(null); }
			catch (err) { messages.push(err.message); }
		}
		console.log(JSON.stringify({ messages }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const { messages } = JSON.parse(child.stdout.trim());
	assert.equal(messages.length, 5);
	const retryable = new Set(["transient", "quota", "network"]);
	for (const message of messages) {
		assert.equal(typeof message, "string", "a billed 200 did not throw");
		const kind = classify(message);
		assert.ok(!retryable.has(kind), `a billed 200 classified as ${kind}, which fallbackOn can silently retry: ${message}`);
		assert.equal(kind, "invalid-response", `expected invalid-response, got ${kind}: ${message}`);
	}
	// The rewrite keeps the information while removing the trigger.
	assert.match(messages[0], /upstream rate-limit notice/);
});

// activityMonitor is what the TUI shows while a search is in flight, and a billed
// non-2xx logged as a 200 is a lie about a charge. Every transition, on every path.
test("the activity entry is opened once and closed with the outcome that happened", async () => {
	const child = runChild(`
		const bodies = [
			{ status: 200, body: ${JSON.stringify(serpBody())} },
			{ status: 401, body: "nope" },
			{ status: 200, body: "<html>not json</html>" },
		];
		let index = 0;
		globalThis.fetch = async () => {
			const next = bodies[index++];
			if (next) return new Response(next.body, { status: next.status });
			throw new Error(index === 4 ? "connect ECONNREFUSED" : "The operation was aborted");
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
		const calls = [
			{},
			{},
			{},
			{},
			{ signal: AbortSignal.abort() },
		];
		for (const options of calls) {
			try { await searchWithBrightData("vector dbs", { domainFilter: ["github.com"], ...options }); } catch {}
		}
		console.log(JSON.stringify(activityMonitor.getEntries().map((entry) => ({
			type: entry.type,
			query: entry.query,
			status: entry.status,
			error: entry.error ?? null,
			closed: entry.endTime !== undefined,
		}))));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const entries = JSON.parse(child.stdout.trim());
	// Exactly one entry per request: logStart is called once, on the request path.
	assert.equal(entries.length, 5);
	for (const entry of entries) {
		assert.equal(entry.type, "api");
		// The logged query is the one actually sent, site: operators included.
		assert.equal(entry.query, "vector dbs site:github.com");
		// No path leaves the entry open, or the TUI shows a spinner forever.
		assert.equal(entry.closed, true);
	}
	assert.deepEqual(entries.map((entry) => entry.status), [
		200,   // success
		401,   // a billed non-2xx is logged as the status it was, never as 200
		200,   // an unreadable 200 was still billed, and is logged as a 200
		null,  // a transport error has no status
		0,     // an abort is closed with 0 rather than logged as an error
	]);
	assert.deepEqual(entries.map((entry) => entry.error), [null, null, null, "connect ECONNREFUSED", null]);
});

// The 60-second budget and the fact that the caller's signal is composed with it rather
// than replacing it. A stub cannot observe a timeout that never fires, so the value is
// read off AbortSignal.timeout at the moment the module asks for it.
test("each request carries a 60-second timeout composed with the caller's signal", async () => {
	const child = runChild(`
		const requested = [];
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		AbortSignal.timeout = (ms) => { requested.push(ms); return realTimeout(ms); };
		let captured = null;
		globalThis.fetch = async (_url, init) => { captured = init.signal; return new Response(JSON.stringify({ organic: [] }), { status: 200 }); };
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});

		await searchWithBrightData("no caller signal");
		const withoutCaller = { isSignal: captured instanceof AbortSignal, aborted: captured.aborted };

		const controller = new AbortController();
		await searchWithBrightData("caller signal", { signal: controller.signal });
		const beforeAbort = captured.aborted;
		controller.abort();
		console.log(JSON.stringify({ requested, withoutCaller, beforeAbort, afterAbort: captured.aborted }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// One timeout per request, at the documented 60 seconds, created per call rather
	// than shared — a module-level signal would expire 60 s after import.
	assert.deepEqual(output.requested, [60_000, 60_000]);
	// With no caller signal the request still carries the timeout signal.
	assert.deepEqual(output.withoutCaller, { isSignal: true, aborted: false });
	// With one, the signal fetch receives is the composition: aborting the caller's
	// aborts the request's.
	assert.equal(output.beforeAbort, false);
	assert.equal(output.afterAbort, true);
});

// Presence, not validity: BRIGHTDATA_SERP_ZONE wins when it is set, and a malformed
// value there must not silently hand the request to the config file's zone. Otherwise a
// typo bills the wrong zone and the error names the wrong setting.
test("BRIGHTDATA_SERP_ZONE takes precedence over brightdataSerpZone, valid or not", async () => {
	const home = await createHome({ brightdataApiKey: "bd-test-key", brightdataSerpZone: "config_zone" });
	const probeScript = `
		let sentZone = null;
		let fetchCalls = 0;
		globalThis.fetch = async (_url, init) => {
			fetchCalls++;
			sentZone = JSON.parse(init.body).zone;
			return new Response(JSON.stringify({ organic: [] }), { status: 200 });
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ sentZone, fetchCalls, error }));
	`;

	const wins = runChild(probeScript, { PI_CODING_AGENT_DIR: home, BRIGHTDATA_SERP_ZONE: "env_zone" });
	assert.equal(wins.status, 0, wins.stderr);
	assert.deepEqual(JSON.parse(wins.stdout.trim()), { sentZone: "env_zone", fetchCalls: 1, error: null });

	const malformed = runChild(probeScript, { PI_CODING_AGENT_DIR: home, BRIGHTDATA_SERP_ZONE: "not a zone" });
	assert.equal(malformed.status, 0, malformed.stderr);
	const output = JSON.parse(malformed.stdout.trim());
	assert.equal(output.fetchCalls, 0, "a malformed env zone never falls back to the config zone");
	assert.equal(output.sentZone, null);
	// The setting the user actually filled in is the setting the error names.
	assert.match(output.error, /Bright Data SERP zone is invalid: BRIGHTDATA_SERP_ZONE must be a zone name/);
	assert.doesNotMatch(output.error, /config_zone/);

	const fromConfig = runChild(probeScript, { PI_CODING_AGENT_DIR: home });
	assert.equal(fromConfig.status, 0, fromConfig.stderr);
	assert.deepEqual(JSON.parse(fromConfig.stdout.trim()), { sentZone: "config_zone", fetchCalls: 1, error: null });
});

// A config file that is not valid JSON. The file is a credential store, so the throw
// must not echo the parser's quoted source: with a short file, V8 puts the whole file
// inside its message, and an unquoted token — a plausible hand-edit — would be printed
// in cleartext. There is no key to redact against here, because the key is what the
// file was being read for.
test("an unparseable config file throws without echoing its contents", async () => {
	const home = await createRawHome(`{"k": bd-planted-token-1234}\n`);
	const child = runChild(`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("", { status: 200 }); };
		const { isBrightDataAvailable, searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let available = null;
		let availabilityError = null;
		try { available = isBrightDataAvailable(); } catch (err) { availabilityError = err.message; }
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ available, availabilityError, error, fetchCalls }));
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// The file is named, the failure is named, and not one character of the file's own
	// text is repeated. V8's message for this input is
	// `Unexpected token 'b', "{"k": bd-planted-token-1234}" is not valid JSON`.
	assert.match(output.error, /^Failed to parse .*web-search\.json: not valid JSON$/);
	assert.doesNotMatch(output.error, /bd-planted-token-1234/);
	assert.equal(output.fetchCalls, 0);
	// Availability stays a total predicate on a config file it cannot read.
	assert.equal(output.availabilityError, null);
	assert.equal(output.available, false);

	// Where V8 reports a position instead of quoting the source, the position is kept:
	// it is the actionable half and it cannot carry file contents.
	const positional = await createRawHome(`{"brightdataApiKey": "bd-test-key",}\n`);
	const positionalChild = runChild(`
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error }));
	`, { PI_CODING_AGENT_DIR: positional });
	assert.equal(positionalChild.status, 0, positionalChild.stderr);
	const positionalOutput = JSON.parse(positionalChild.stdout.trim());
	assert.match(positionalOutput.error, /Failed to parse .*web-search\.json: not valid JSON, at position 35 \(line 1 column 36\)$/);
	assert.doesNotMatch(positionalOutput.error, /bd-test-key/);

	// The other half of dropping the parser message: the file's contents can no longer
	// forge a status either. `Unexpected token 'e', "{"k": error 503}" …` would be read
	// as a 5xx by providerErrorStatus and classified transient ahead of the config
	// wording branch.
	const forging = await createRawHome(`{"k": error 503}\n`);
	const forgingChild = runChild(`
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		let error = null;
		try { await searchWithBrightData("q"); } catch (err) { error = err.message; }
		console.log(JSON.stringify({ error, statuses: error.match(/\\b(?:error|status|http)[\\s:=-]{1,4}\\d{3}\\b/gi) }));
	`, { PI_CODING_AGENT_DIR: forging });
	assert.equal(forgingChild.status, 0, forgingChild.stderr);
	const forgingOutput = JSON.parse(forgingChild.stdout.trim());
	assert.match(forgingOutput.error, /Failed to parse .*web-search\.json: not valid JSON/);
	assert.equal(forgingOutput.statuses, null);
});

// Bright Data's error envelope is only known from its documentation, so every shape the
// module claims to read is pinned: a string `error`, an object `error`, a string or
// array `errors`, and both spellings of the code, as a string and as a number.
test("Bright Data's 200 error envelope is reported whatever shape it arrives in", async () => {
	const child = runChild(`
		const bodies = [
			JSON.stringify({ error: { reason: "wrong zone type" }, error_code: 42 }),
			JSON.stringify({ errors: "two things went wrong", code: 7 }),
			JSON.stringify({ error: "B".repeat(400) }),
		];
		let index = 0;
		globalThis.fetch = async () => new Response(bodies[index++], { status: 200 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const errors = [];
		for (let i = 0; i < bodies.length; i++) {
			try { await searchWithBrightData("q"); errors.push(null); } catch (err) { errors.push(err.message); }
		}
		console.log(JSON.stringify({ errors }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const errors = JSON.parse(child.stdout.trim()).errors;
	// A non-string error is serialized rather than reported as "[object Object]".
	assert.match(errors[0], /Bright Data reported an error instead of a SERP: \{"reason":"wrong zone type"\}/);
	assert.match(errors[0], /error_code 42/);
	assert.match(errors[1], /Bright Data reported an error instead of a SERP: two things went wrong/);
	assert.match(errors[1], /code 7/);
	// The envelope has its own 200-character cap, applied on this path rather than by
	// the message builder that wraps it.
	assert.match(errors[2], new RegExp(`instead of a SERP: B{200}$`));
});

// The query the engine receives, for the filter shapes the mapping test does not build:
// a single include, an exclude on its own, an unusable filter value, and a recency value
// outside the four Google windows.
test("site: operators, filter normalization and an unknown recency window", async () => {
	const child = runChild(`
		const sent = [];
		globalThis.fetch = async (_url, init) => {
			sent.push(new URL(JSON.parse(init.body).url));
			return new Response(JSON.stringify({ organic: [] }), { status: 200 });
		};
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		await searchWithBrightData("q", { domainFilter: ["github.com"] });
		await searchWithBrightData("q", { domainFilter: ["-example.com"] });
		await searchWithBrightData("q", { domainFilter: ["https://GitHub.com/some/path", "github.com", "not a domain", "-", "  ", "-Gist.GitHub.com"] });
		await searchWithBrightData("q", { recencyFilter: "decade" });
		await searchWithBrightData("q", { numResults: Number.NaN });
		console.log(JSON.stringify(sent.map((url) => ({ q: url.searchParams.get("q"), tbs: url.searchParams.get("tbs"), num: url.searchParams.get("num") }))));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const sent = JSON.parse(child.stdout.trim());
	// A single include is a bare site:, not a one-armed OR group.
	assert.equal(sent[0].q, "q site:github.com");
	// An exclude with no include is still expressed to the engine.
	assert.equal(sent[1].q, "q -site:example.com");
	// A URL is reduced to its host, case is folded, duplicates collapse, and values
	// that are not domains are dropped rather than smuggled into the query.
	assert.equal(sent[2].q, "q site:github.com -site:gist.github.com");
	// Only the four Google windows map to tbs; anything else is no filter at all,
	// never a query-text hint.
	assert.equal(sent[3].tbs, null);
	assert.equal(sent[3].q, "q");
	// A non-finite count falls back to the default of 5, plus the headroom.
	assert.equal(sent[4].num, "10");
});

// The mapping rules for entries a real SERP contains: no title, no description, and a
// link that is not a parseable URL once a filter is in play.
test("organic entries missing fields are mapped, and unparseable links are dropped", async () => {
	const organic = [
		{ link: "https://a.example/1" },
		{ link: "not-a-url", title: "Bad link" },
		{ link: "https://b.example/2", title: "T2", description: "  s2   s2  " },
	];
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ organic: ${JSON.stringify(organic)} }), { status: 200 });
		const { searchWithBrightData } = await import(${JSON.stringify(brightdataModuleUrl)});
		const unfiltered = await searchWithBrightData("q");
		const filtered = await searchWithBrightData("q", { domainFilter: ["b.example"] });
		console.log(JSON.stringify({ unfiltered, filtered }));
	`, { BRIGHTDATA_API_KEY: "bd-test-key", BRIGHTDATA_SERP_ZONE: "pi_serp" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// A missing title becomes a positional label; a missing description an empty
	// snippet — neither discards a result that was already paid for.
	assert.deepEqual(output.unfiltered.results, [
		{ title: "Source 1", url: "https://a.example/1", snippet: "" },
		{ title: "Bad link", url: "not-a-url", snippet: "" },
		{ title: "T2", url: "https://b.example/2", snippet: "s2 s2" },
	]);
	// The assembled answer omits the "snippet\n" half for a snippet-less source.
	assert.equal(
		output.unfiltered.answer,
		"Source: Source 1 (https://a.example/1)\n\nSource: Bad link (not-a-url)\n\ns2 s2\nSource: T2 (https://b.example/2)",
	);
	// With a filter in play a link that is not a URL cannot be matched against it, so
	// it is dropped rather than assumed to pass.
	assert.deepEqual(output.filtered.results, [{ title: "T2", url: "https://b.example/2", snippet: "s2 s2" }]);
});

test("Bright Data is never selected by auto without explicit routing", async () => {
	const home = await createHome({ brightdataApiKey: "bd-test-key", brightdataSerpZone: "pi_serp" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("unexpected auto provider"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try { await search("auto", { provider: "auto" }); console.log(JSON.stringify({ ok: true, calls })); }
		catch (err) { console.log(JSON.stringify({ ok: false, error: String(err), calls })); }
	`, { PI_CODING_AGENT_DIR: home });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// Configuring a paid, per-request SERP proxy must not silently start billing
	// through the zero-config auto chain.
	assert.ok(output.calls.every((url) => !url.startsWith("https://api.brightdata.com/")));
	assert.doesNotMatch(output.error ?? "", /Bright Data/);
});

for (const [status, kind] of [[400, "invalid-request"], [401, "auth"], [403, "auth"], [402, "quota"], [429, "quota"], [500, "transient"], [503, "transient"], [504, "transient"]]) {
	test(`Bright Data HTTP ${status} is classified as ${kind}`, async () => {
		const home = await createHome({
			brightdataApiKey: "bd-test-key",
			brightdataSerpZone: "pi_serp",
			searchRouting: {
				providers: ["brightdata", "brave"],
				fallbackOn: [kind === "auth" || kind === "invalid-request" ? "quota" : kind],
			},
		});
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				if (String(url) === "https://api.brightdata.com/request") return new Response("provider failure", { status: ${status} });
				return new Response(JSON.stringify({ web: { results: [{ title: "fallback", url: "https://example.com/fallback", description: "ok" }] } }), { status: 200 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			try { const result = await search("classified", { provider: "auto" }); console.log(JSON.stringify({ ok: true, provider: result.provider, calls })); }
			catch (err) { console.log(JSON.stringify({ ok: false, error: String(err), calls })); }
		`, { PI_CODING_AGENT_DIR: home, BRAVE_API_KEY: "brave-key" });

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		if (kind === "auth" || kind === "invalid-request") {
			assert.equal(output.ok, false);
			assert.match(output.error, new RegExp(`brightdata search failed \\(${kind}\\)`));
			assert.deepEqual(output.calls, ["https://api.brightdata.com/request"]);
		} else {
			assert.equal(output.ok, true);
			assert.equal(output.provider, "brave");
			assert.equal(output.calls.length, 2);
		}
	});
}

test("curator page exposes Bright Data as a manual provider", async () => {
	const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["brightdata query"],
		"session-token",
		20,
		{
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: false,
			tavily: false,
			serpdive: false,
			brightdata: true,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: false,
			kimi: false,
			anysearch: false,
		},
		"brightdata",
		"brightdata",
		[],
		null,
	);
	assert.match(page, /data-provider="brightdata"/);
	assert.match(page, />Bright Data<\/button>/);
	assert.match(page, /provider-tag\.provider-brightdata/);
});
