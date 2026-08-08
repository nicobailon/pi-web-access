import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const brightdataModuleUrl = new URL(
	"../brightdata-unlocker.ts",
	import.meta.url,
).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;

// Scrubbing the env vars is not enough on its own: a `brightdataApiKey` written
// as an explicit `$VAR`/`!command` source in the real `~/.pi/web-search.json`
// overrides the environment by design, so a maintainer with one configured
// would resolve their own credential (and run their own resolver command)
// inside these tests. Every child therefore starts from an empty home unless a
// test hands it a purpose-built one.
const EMPTY_HOME = mkdtempSync(
	join(tmpdir(), "pi-web-access-brightdata-empty-home-"),
);

function runChild(script, env = {}) {
	const childEnv = {
		...process.env,
		HOME: EMPTY_HOME,
		USERPROFILE: EMPTY_HOME,
	};
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"BRIGHTDATA_API_KEY",
		"KAGI_API_KEY",
		"OLLAMA_API_KEY",
		"BRIGHTDATA_UNLOCKER_ZONE",
		"BRIGHTDATA_SERP_ZONE",
		"FIRECRAWL_BASE_URL",
		"FIRECRAWL_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"GEMINI_API_KEY",
	])
		delete childEnv[key];
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
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brightdata-"));
	await writeFile(
		join(home, "web-search.json"),
		JSON.stringify(config) + "\n",
		"utf8",
	);
	return home;
}

test("Bright Data Web Unlocker maps markdown and sends the credential and Unlocker zone", async () => {
	const child = runChild(
		`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, redirect: init.redirect, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response("# Unlocked Title\\n\\nUnlocked body.\\n", { status: 200 });
		};
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await extractWithBrightDataUnlocker("https://example.com/article", undefined, {
			lookup: ${PUBLIC_LOOKUP},
		});
		console.log(JSON.stringify({ captured, result }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-test-key",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://api.brightdata.com/request");
	assert.equal(output.captured.method, "POST");
	// `redirect: "manual"` is pinned here rather than inferred from the redirect
	// tests below, because the stub `fetch` cannot follow a redirect and so cannot
	// observe the difference. Under the real `fetch` the default ("follow")
	// resolves the chain in the runtime and hands back a 200, at which point
	// REDIRECT_STATUSES.has(200) is false, fetchBrightDataApi returns on the first
	// iteration, and the per-hop validateRemoteUrl, the cross-origin credential
	// strip and the 5-hop cap are all unreachable in production while every
	// redirect test below still passes. Same idiom as
	// test/gemini-web-cookie-opt-in.test.mjs:42 and test/search-providers.test.mjs:173.
	assert.equal(output.captured.redirect, "manual");
	assert.equal(output.captured.headers.authorization, "Bearer bd-test-key");
	assert.equal(output.captured.headers["content-type"], "application/json");
	// The Unlocker zone is sent verbatim, and markdown is requested at the API
	// rather than converted locally.
	assert.deepEqual(output.captured.body, {
		url: "https://example.com/article",
		zone: "pi_unlocker",
		format: "raw",
		data_format: "markdown",
	});
	assert.deepEqual(output.result, {
		url: "https://example.com/article",
		title: "Unlocked Title",
		content: "# Unlocked Title\n\nUnlocked body.",
		error: null,
	});
});

test("Bright Data Web Unlocker rejects private targets without invoking the paid API", async () => {
	const child = runChild(
		`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("# Should never happen", { status: 200 }); };
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		const errors = [];
		for (const target of ["http://127.0.0.1:8080/admin", "http://localhost:8080/admin", "http://169.254.169.254/latest/meta-data"]) {
			try { await extractWithBrightDataUnlocker(target); } catch (err) { errors.push(err.message); }
		}
		try { await extractWithBrightDataUnlocker("https://internal.example.com/", undefined, { lookup: async () => [{ address: "10.0.0.5", family: 4 }] }); }
		catch (err) { errors.push(err.message); }
		// A second resolved address in a private range must also block: the guard
		// checks every answer, not the first.
		try { await extractWithBrightDataUnlocker("https://rebind.example.com/", undefined, { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.10", family: 4 }] }); }
		catch (err) { errors.push(err.message); }
		console.log(JSON.stringify({ errors, fetchCalls }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-test-key",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// The stub fetch succeeds, so a zero call count can only mean the guard ran first.
	assert.equal(output.fetchCalls, 0);
	assert.equal(output.errors.length, 5);
	assert.match(output.errors[0], /Blocked internal address/);
	assert.match(output.errors[1], /Blocked internal hostname/);
	assert.match(output.errors[2], /Blocked internal address/);
	assert.match(output.errors[3], /Blocked internal address/);
	assert.match(output.errors[4], /Blocked internal address/);
});

// Redundancy is deliberate and is called out so it is not read as padding: what
// actually stops this case is `extractContent`'s own up-front `validateRemoteUrl`
// (`extract.ts:246-259`), which returns before any provider in the chain is
// consulted — not `brightdata-unlocker.ts`'s guard, which the preceding test
// pins directly. It is kept because the review asked for an end-to-end proof
// that a blocked private target never reaches Bright Data, and because it is the
// only test that fails if the Bright Data block is ever moved above that
// up-front guard or if "Blocked internal address" is made a recoverable error
// the chain continues past.
test("Bright Data Web Unlocker is not reached for a blocked target through fetch_content", async () => {
	const home = await configHome({
		brightdataApiKey: "bd-test-key",
		brightdataUnlockerZone: "pi_unlocker",
	});
	const child = runChild(
		`
		let fetchCalls = [];
		globalThis.fetch = async (url) => { fetchCalls.push(String(url)); return new Response("# Should never happen", { status: 200 }); };
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("http://169.254.169.254/latest/meta-data");
		console.log(JSON.stringify({ fetchCalls, error: result.error, content: result.content }));
	`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home },
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.fetchCalls, []);
	assert.equal(output.content, "");
	assert.match(output.error, /Blocked internal address/);
});

test("Bright Data Web Unlocker validates its own fixed API endpoint, not just the target", async () => {
	// The endpoint is a hardcoded constant, so the only way it becomes private is a
	// resolution that points api.brightdata.com at an internal address. The lookup
	// is hostname-aware so the *target* still passes: that is what isolates the
	// endpoint check from the target check, which every other test exercises.
	const child = runChild(
		`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("# Should never happen", { status: 200 }); };
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let message = null;
		try {
			await extractWithBrightDataUnlocker("https://example.com/a", undefined, {
				lookup: async (hostname) => hostname === "api.brightdata.com"
					? [{ address: "10.0.0.5", family: 4 }]
					: [{ address: "93.184.216.34", family: 4 }],
			});
		} catch (err) { message = err.message; }
		console.log(JSON.stringify({ message, fetchCalls }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-test-key",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.fetchCalls, 0);
	assert.match(output.message, /Blocked internal address/);
});

test("Bright Data Web Unlocker credentials are stripped on public cross-origin API redirects", async () => {
	const child = runChild(
		`
		let calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), auth: Object.fromEntries(new Headers(init.headers)).authorization ?? null });
			if (calls.length === 1) return new Response("", { status: 307, headers: { location: "https://mirror.example.com/request" } });
			return new Response("# Redirect body", { status: 200 });
		};
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		const result = await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-secret",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		{ url: "https://api.brightdata.com/request", auth: "Bearer bd-secret" },
		{ url: "https://mirror.example.com/request", auth: null },
	]);
	assert.deepEqual(output.result, {
		url: "https://example.com/a",
		title: "Redirect body",
		content: "# Redirect body",
		error: null,
	});
});

test("Bright Data Web Unlocker blocks API redirects to private targets", async () => {
	const child = runChild(
		`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
		};
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let redirectError = null;
		try { await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { redirectError = err.message; }
		console.log(JSON.stringify({ calls, redirectError }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-test-key",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// The hop was validated before it was followed, so only the first request happened.
	assert.deepEqual(output.calls, ["https://api.brightdata.com/request"]);
	assert.match(output.redirectError, /Blocked internal address/);
});

test("Bright Data Web Unlocker stops after five API redirects with an explicit message", async () => {
	const child = runChild(
		`
		let calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), auth: Object.fromEntries(new Headers(init.headers)).authorization ?? null });
			return new Response("", { status: 302, headers: { location: "https://hop" + calls.length + ".example.com/request" } });
		};
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let message = null;
		try { await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { message = err.message; }
		console.log(JSON.stringify({ calls, message }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-secret",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// Six requests total: the initial POST plus exactly DEFAULT_MAX_REDIRECTS = 5
	// followed hops. A seventh would mean the cap does not hold.
	assert.deepEqual(
		output.calls.map((call) => call.url),
		[
			"https://api.brightdata.com/request",
			"https://hop1.example.com/request",
			"https://hop2.example.com/request",
			"https://hop3.example.com/request",
			"https://hop4.example.com/request",
			"https://hop5.example.com/request",
		],
	);
	// The cap raises a named error rather than returning null or the last 302 body,
	// and it names the hop it gave up on.
	assert.equal(
		output.message,
		"Too many redirects fetching https://hop5.example.com/request",
	);
	// The credential is dropped at the first origin change and never reinstated.
	assert.deepEqual(
		output.calls.map((call) => call.auth),
		["Bearer bd-secret", null, null, null, null, null],
	);
	assert.equal(output.message.includes("bd-secret"), false);
});

test("BRIGHTDATA_UNLOCKER_ZONE takes precedence over brightdataUnlockerZone in the config file", async () => {
	// Both sources are populated at once, so the assertion can only pass if the
	// precedence order is the documented one. Reversing it in getZone() still
	// typechecks and still passes every other test in this file.
	const home = await configHome({
		brightdataApiKey: "bd-test-key",
		brightdataUnlockerZone: "config_zone1",
	});
	for (const { env, expected } of [
		{ env: {}, expected: "config_zone1" },
		{ env: { BRIGHTDATA_UNLOCKER_ZONE: "env_zone1" }, expected: "env_zone1" },
	]) {
		const child = runChild(
			`
			let zone = null;
			globalThis.fetch = async (_url, init) => {
				zone = JSON.parse(init.body).zone;
				return new Response("# Zone body", { status: 200 });
			};
			const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
			await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
			console.log(JSON.stringify({ zone }));
		`,
			{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, ...env },
		);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(
			JSON.parse(child.stdout.trim()).zone,
			expected,
			JSON.stringify(env),
		);
	}
});

test("Bright Data Web Unlocker requires its own zone and never borrows the SERP zone", async () => {
	const home = await configHome({
		brightdataApiKey: "bd-test-key",
		brightdataSerpZone: "serp_zone1",
	});
	const child = runChild(
		`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("# Should never happen", { status: 200 }); };
		const { extractWithBrightDataUnlocker, isBrightDataUnlockerAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		const available = isBrightDataUnlockerAvailable();
		let zoneError = null;
		try { await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { zoneError = err.message; }
		console.log(JSON.stringify({ available, zoneError, fetchCalls }));
	`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home },
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// A SERP-only configuration must not opt the user into Web Unlocker spend.
	assert.equal(output.available, false);
	assert.equal(output.fetchCalls, 0);
	assert.match(
		output.zoneError,
		/Bright Data Web Unlocker zone not configured/,
	);
	assert.match(output.zoneError, /brightdataUnlockerZone/);
	assert.match(output.zoneError, /BRIGHTDATA_UNLOCKER_ZONE/);
});

test("Bright Data Web Unlocker availability needs both a zone and a credential source", async () => {
	const cases = [
		{ env: {}, expected: false },
		{ env: { BRIGHTDATA_API_KEY: "bd-test-key" }, expected: false },
		{ env: { BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker" }, expected: false },
		{
			env: {
				BRIGHTDATA_API_KEY: "bd-test-key",
				BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
			},
			expected: true,
		},
		{
			env: {
				BRIGHTDATA_API_KEY: "bd-test-key",
				BRIGHTDATA_UNLOCKER_ZONE: "https://zone.example.com",
			},
			expected: false,
		},
	];
	for (const { env, expected } of cases) {
		const child = runChild(
			`
			const { isBrightDataUnlockerAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
			console.log(JSON.stringify({ available: isBrightDataUnlockerAvailable() }));
		`,
			env,
		);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(
			JSON.parse(child.stdout.trim()).available,
			expected,
			JSON.stringify(env),
		);
	}
});

test("Bright Data Web Unlocker resolves the credential at request time, after the SSRF guard", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brightdata-"));
	const marker = join(home, "resolver-ran");
	await writeFile(
		join(home, "web-search.json"),
		JSON.stringify({
			brightdataApiKey: `!touch ${marker} && printf bd-command-key`,
			brightdataUnlockerZone: "pi_unlocker",
		}) + "\n",
		"utf8",
	);
	const child = runChild(
		`
		import { existsSync } from "node:fs";
		let auth = null;
		globalThis.fetch = async (_url, init) => {
			auth = Object.fromEntries(new Headers(init.headers)).authorization ?? null;
			return new Response("# Command body", { status: 200 });
		};
		const { extractWithBrightDataUnlocker, isBrightDataUnlockerAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		const availableBefore = isBrightDataUnlockerAvailable();
		const ranBefore = existsSync(${JSON.stringify(marker)});
		// A blocked target must not spawn the credential command either.
		let blockedError = null;
		try { await extractWithBrightDataUnlocker("http://127.0.0.1:8080/admin"); } catch (err) { blockedError = err.message; }
		const ranAfterBlocked = existsSync(${JSON.stringify(marker)});
		await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} });
		const ranAfter = existsSync(${JSON.stringify(marker)});
		console.log(JSON.stringify({ availableBefore, ranBefore, blockedError, ranAfterBlocked, ranAfter, auth }));
	`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home },
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.availableBefore, true);
	assert.equal(output.ranBefore, false);
	assert.match(output.blockedError, /Blocked internal address/);
	assert.equal(output.ranAfterBlocked, false);
	assert.equal(output.ranAfter, true);
	assert.equal(output.auth, "Bearer bd-command-key");
});

test("Bright Data Web Unlocker HTTP failures surface the status and redact the credential", async () => {
	const child = runChild(
		`
		globalThis.fetch = async () => new Response("payment required for token bd-secret", { status: 402 });
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let message = null;
		let result = "not-reached";
		try { result = await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { message = err.message; }
		console.log(JSON.stringify({ message, result }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-secret",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// A paid failure throws; it is never collapsed into a silent null.
	assert.equal(output.result, "not-reached");
	assert.match(output.message, /Bright Data Web Unlocker error 402/);
	assert.match(output.message, /payment required/);
	assert.match(output.message, /\[redacted\]/);
	assert.equal(output.message.includes("bd-secret"), false);
});

test("Bright Data Web Unlocker redacts the credential before truncating a long error body", async () => {
	// Order is the property under test. The body is redacted *before* the
	// 300-character slice; if it were sliced first, a token straddling the boundary
	// would be cut into a fragment that the later message-level redaction cannot
	// match by exact string, and the fragment would reach the user. Both redactions
	// individually pass the 402 test above, so only this one can tell them apart.
	const child = runChild(
		`
		const key = "bd-boundary-secret-0123456789";
		globalThis.fetch = async () => new Response("e".repeat(280) + key + " trailing detail", { status: 500 });
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let message = null;
		try { await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { message = err.message; }
		console.log(JSON.stringify({ message }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-boundary-secret-0123456789",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.message, /Bright Data Web Unlocker error 500/);
	assert.match(output.message, /\[redacted\]/);
	// Not even a prefix of the token survives the truncation.
	assert.equal(output.message.includes("bd-bound"), false);
});

test("Bright Data Web Unlocker redacts transport errors and preserves the error name", async () => {
	// The catch-level redaction, pinned on its own: this path never touches the
	// response-body redaction, and it must rebuild the error without losing
	// `err.name`, which is what downstream abort detection reads.
	const child = runChild(
		`
		globalThis.fetch = async () => {
			const err = new Error("socket hang up while sending token bd-secret");
			err.name = "TypeError";
			throw err;
		};
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let name = null;
		let message = null;
		let result = "not-reached";
		try { result = await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { name = err.name; message = err.message; }
		console.log(JSON.stringify({ name, message, result }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-secret",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result, "not-reached");
	assert.equal(output.name, "TypeError");
	assert.match(output.message, /socket hang up/);
	assert.match(output.message, /\[redacted\]/);
	assert.equal(output.message.includes("bd-secret"), false);
});

test("Bright Data Web Unlocker returns null only for genuinely empty content", async () => {
	const child = runChild(
		`
		const bodies = ["", "   \\n\\t  ", "Paywalled: subscribe to continue reading."];
		let index = 0;
		globalThis.fetch = async () => new Response(bodies[index++], { status: 200 });
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		const results = [];
		for (let i = 0; i < bodies.length; i++) {
			results.push(await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }));
		}
		console.log(JSON.stringify({ results }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-test-key",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const results = JSON.parse(child.stdout.trim()).results;
	assert.equal(results[0], null);
	assert.equal(results[1], null);
	// Short content is billed content: it is returned, not silently dropped.
	assert.deepEqual(results[2], {
		url: "https://example.com/a",
		title: "",
		content: "Paywalled: subscribe to continue reading.",
		error: null,
	});
});

test("Bright Data Web Unlocker propagates cancellation instead of returning null", async () => {
	const child = runChild(
		`
		let sawAbortedSignal = null;
		globalThis.fetch = async (_url, init) => {
			sawAbortedSignal = init.signal?.aborted ?? null;
			if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
			return new Response("# Never returned", { status: 200 });
		};
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let name = null;
		let message = null;
		try { await extractWithBrightDataUnlocker("https://example.com/a", AbortSignal.abort(), { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { name = err.name; message = err.message; }
		console.log(JSON.stringify({ sawAbortedSignal, name, message }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-test-key",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	// The caller signal reaches the request, and the abort is rethrown so
	// extractContent can report "Aborted" instead of falling through the chain.
	assert.equal(output.sawAbortedSignal, true);
	assert.equal(output.name, "AbortError");
	assert.match(output.message, /aborted/i);
});

test("Bright Data Web Unlocker uses fetch_content's timeoutMs and its own 60s default otherwise", async () => {
	const child = runChild(
		`
		// AbortSignal.timeout is the only place the effective budget is observable,
		// and the signal it returns is the one handed to fetch.
		const realTimeout = AbortSignal.timeout;
		const requested = [];
		AbortSignal.timeout = (ms) => { requested.push(ms); return realTimeout.call(AbortSignal, ms); };

		let sawSignal = null;
		globalThis.fetch = async (_url, init) => {
			sawSignal = init.signal instanceof AbortSignal;
			return new Response("# Body", { status: 200 });
		};
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});

		await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP}, timeoutMs: 12345 });
		const explicit = requested.splice(0);
		await extractWithBrightDataUnlocker("https://example.com/b", undefined, { lookup: ${PUBLIC_LOOKUP} });
		const fallback = requested.splice(0);

		// A tiny budget must actually abort the in-flight request, not merely be recorded.
		globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
			// AbortSignal.timeout unrefs its timer, so hold the loop open ourselves;
			// otherwise the child exits before the deadline and proves nothing.
			const keepAlive = setTimeout(() => {}, 5000);
			init.signal.addEventListener("abort", () => {
				clearTimeout(keepAlive);
				reject(new DOMException("This operation was aborted", "AbortError"));
			});
		});
		let timedOutName = null;
		let timedOutResult = "not-reached";
		try { timedOutResult = await extractWithBrightDataUnlocker("https://example.com/c", undefined, { lookup: ${PUBLIC_LOOKUP}, timeoutMs: 25 }); }
		catch (err) { timedOutName = err.name; }
		console.log(JSON.stringify({ explicit, fallback, tiny: requested, sawSignal, timedOutName, timedOutResult }));
	`,
		{
			BRIGHTDATA_API_KEY: "bd-test-key",
			BRIGHTDATA_UNLOCKER_ZONE: "pi_unlocker",
		},
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.sawSignal, true);
	// The caller's budget is used verbatim, not clamped and not ignored.
	assert.deepEqual(output.explicit, [12345]);
	// With no caller budget the module's own EXTRACT_TIMEOUT_MS applies. This is
	// deliberately 60s, not the 30s of the direct HTTP path, because Bright Data is
	// retrying and rendering on our behalf; it matches firecrawl.ts:10.
	assert.deepEqual(output.fallback, [60_000]);
	assert.deepEqual(output.tiny, [25]);
	// A timeout is a thrown abort, never a silent null the chain walks past.
	assert.equal(output.timedOutResult, "not-reached");
	assert.equal(output.timedOutName, "AbortError");
});

// Scope, stated exactly: this fixture configures Bright Data and nothing else, so
// Firecrawl, TinyFish and Parallel are unavailable and make no calls. Their
// position relative to Bright Data is therefore NOT what this asserts — only
// that Bright Data runs after the direct HTTP fetch and Jina Reader, and that a
// Bright Data hit returns before the Gemini fallbacks are consulted. The full
// ordering is a source-order property of `extractContent`, not a tested one.
test("fetch_content tries Bright Data after the direct fetch and Jina Reader, and returns before Gemini", async () => {
	const home = await configHome({
		brightdataApiKey: "bd-test-key",
		brightdataUnlockerZone: "pi_unlocker",
		fetchRouting: { allowRemoteHostedProviders: true },
	});
	const child = runChild(
		`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			if (String(url).startsWith("https://r.jina.ai/")) return new Response("nope", { status: 500 });
			return new Response("# Unblocked\\n\\nUnblocked body.", { status: 200 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/protected", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, result }));
	`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home },
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.com/protected",
		"https://r.jina.ai/https://example.com/protected",
		"https://api.brightdata.com/request",
	]);
	assert.deepEqual(output.result, {
		url: "https://example.com/protected",
		title: "Unblocked",
		content: "# Unblocked\n\nUnblocked body.",
		error: null,
	});
});

test("Bright Data Web Unlocker failures stay visible in fetch_content guidance", async () => {
	const home = await configHome({
		brightdataApiKey: "bd-secret",
		brightdataUnlockerZone: "pi_unlocker",
		fetchRouting: { allowRemoteHostedProviders: true },
	});
	const child = runChild(
		`
		let calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (calls.length === 1) return new Response("blocked", { status: 403 });
			if (String(url).startsWith("https://r.jina.ai/")) return new Response("nope", { status: 500 });
			return new Response("payment required for token bd-secret", { status: 402 });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.com/paywalled", undefined, { lookup: ${PUBLIC_LOOKUP} });
		console.log(JSON.stringify({ calls, error: result.error }));
	`,
		{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home },
	);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(
		output.error,
		/Bright Data fallback failed: Bright Data Web Unlocker error 402/,
	);
	assert.match(
		output.error,
		/Set brightdataApiKey and brightdataUnlockerZone in .*web-search\.json or BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE/,
	);
	assert.equal(output.error.includes("bd-secret"), false);
});

test("Bright Data Web Unlocker rejects a malformed zone and a malformed config root", async () => {
	const badZone = await configHome({
		brightdataApiKey: "bd-test-key",
		brightdataUnlockerZone: "https://zone.example.com",
	});
	const badZoneChild = runChild(
		`
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls++; return new Response("# Should never happen", { status: 200 }); };
		const { extractWithBrightDataUnlocker, isBrightDataUnlockerAvailable } = await import(${JSON.stringify(brightdataModuleUrl)});
		const available = isBrightDataUnlockerAvailable();
		let message = null;
		try { await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { message = err.message; }
		console.log(JSON.stringify({ available, message, fetchCalls }));
	`,
		{ HOME: badZone, USERPROFILE: badZone, PI_CODING_AGENT_DIR: badZone },
	);
	assert.equal(badZoneChild.status, 0, badZoneChild.stderr);
	const badZoneOutput = JSON.parse(badZoneChild.stdout.trim());
	assert.equal(badZoneOutput.available, false);
	assert.equal(badZoneOutput.fetchCalls, 0);
	assert.match(
		badZoneOutput.message,
		/Invalid Bright Data Unlocker zone: brightdataUnlockerZone in .*web-search\.json/,
	);

	const badRoot = await mkdtemp(join(tmpdir(), "pi-web-access-brightdata-"));
	await writeFile(join(badRoot, "web-search.json"), "[]\n", "utf8");
	const badRootChild = runChild(
		`
		const { extractWithBrightDataUnlocker } = await import(${JSON.stringify(brightdataModuleUrl)});
		let message = null;
		try { await extractWithBrightDataUnlocker("https://example.com/a", undefined, { lookup: ${PUBLIC_LOOKUP} }); }
		catch (err) { message = err.message; }
		console.log(JSON.stringify({ message }));
	`,
		{ HOME: badRoot, USERPROFILE: badRoot, PI_CODING_AGENT_DIR: badRoot },
	);
	assert.equal(badRootChild.status, 0, badRootChild.stderr);
	assert.match(
		JSON.parse(badRootChild.stdout.trim()).message,
		/Invalid config in .*web-search\.json: expected a JSON object/,
	);
});

test("a private Bright Data endpoint mirror requires an explicit narrow SSRF range", async () => {
	// The API host is fixed, so the only way a private address can be reached is
	// through a redirect. That hop is exempt only when the user opted a narrow
	// range into ssrf.allowRanges, which extract.ts threads in per attempt.
	for (const allowRanges of [undefined, ["127.0.0.0/8"]]) {
		const home = await configHome({
			brightdataApiKey: "bd-test-key",
			brightdataUnlockerZone: "pi_unlocker",
			fetchRouting: { allowRemoteHostedProviders: true },
			...(allowRanges ? { ssrf: { allowRanges } } : {}),
		});
		const child = runChild(
			`
			let calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				if (calls.length === 1) return new Response("blocked", { status: 403 });
				if (String(url).startsWith("https://r.jina.ai/")) return new Response("nope", { status: 500 });
				if (String(url) === "https://api.brightdata.com/request") {
					return new Response("", { status: 307, headers: { location: "http://127.0.0.1:3002/request" } });
				}
				return new Response("# Local mirror", { status: 200 });
			};
			const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractContent("https://example.com/protected", undefined, { lookup: ${PUBLIC_LOOKUP} });
			console.log(JSON.stringify({ calls, result }));
		`,
			{ HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home },
		);
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		if (allowRanges) {
			assert.deepEqual(output.calls.slice(2), [
				"https://api.brightdata.com/request",
				"http://127.0.0.1:3002/request",
			]);
			assert.equal(output.result.content, "# Local mirror");
		} else {
			assert.deepEqual(output.calls.slice(2), [
				"https://api.brightdata.com/request",
			]);
			assert.match(
				output.result.error,
				/Bright Data fallback failed: Blocked internal address/,
			);
		}
	}
});
