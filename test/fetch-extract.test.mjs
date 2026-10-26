import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { extractPageFields, parseExtractFields } from "../field-extract.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const pdfFixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;
const CLAIRIC_URL = "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clairic";
const CF_TOKEN = "cf-secret-token-123";
const PAGE_A = "https://93.184.216.34/a";
const PAGE_B = "https://93.184.216.34/b";
const PAGE_PDF = "https://93.184.216.34/fees.pdf";
const extractConfig = { fetch: { allowedModes: ["readable", "extract"] } };

// The config path is fixed per process, so each scenario runs in its own child. Pages /a and /b are plain text and
// /fees.pdf is a PDF; the Clairic reply is picked by which page is in the request.
// Pi supplies the Cloudflare credential through ctx.modelRegistry; `setUp: false` fakes a Pi without it.
function runFetch(config, calls, replies = {}, { setUp = true, fails = false } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-web-access-fetch-extract-"));
	if (config !== undefined) writeFileSync(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: agentDir, XDG_CONFIG_HOME: "", HOME: join(agentDir, "home"), USERPROFILE: join(agentDir, "home"), CALLS: JSON.stringify(calls), REPLIES: JSON.stringify(replies), CF_SET_UP: setUp ? "1" : "" };
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			import { makePdf } from ${JSON.stringify(pdfFixtureUrl)};
			const replies = JSON.parse(process.env.REPLIES);
			const clairicRequests = [];
			let pageFetches = 0;
			globalThis.fetch = async (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url === ${JSON.stringify(PAGE_A)} || url === ${JSON.stringify(PAGE_B)}) {
					pageFetches++;
					return new Response(url.endsWith("/a") ? "Alpha page. Order total $42.10." : "Beta page.", { headers: { "content-type": "text/plain" } });
				}
				if (url === ${JSON.stringify(PAGE_PDF)}) {
					pageFetches++;
					return new Response(makePdf("The annual fee is 42 dollars."), { headers: { "content-type": "application/pdf" } });
				}
				clairicRequests.push({ url, authorization: init.headers.Authorization, body: init.body });
				const state = JSON.parse(init.body).state;
				const reply = state.startsWith("Alpha") ? replies.a : state.startsWith("Beta") ? replies.b : replies.pdf;
				return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
			};
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			const fetchTool = tools.find((tool) => tool.name === "fetch_content");
			const today = new Date().toISOString().slice(0, 10);
			const results = [];
			for (const params of JSON.parse(process.env.CALLS)) {
				const modelRegistry = {
					async getProviderAuth(provider) {
						return provider === "cloudflare-workers-ai" && process.env.CF_SET_UP ? { auth: { apiKey: ${JSON.stringify(CF_TOKEN)} }, env: { CLOUDFLARE_ACCOUNT_ID: "acct-1" } } : undefined;
					},
				};
				const result = await fetchTool.execute("call", params, undefined, undefined, { modelRegistry });
				const stored = result.details.responseId
					? (await tools.find((tool) => tool.name === "get_search_content").execute("get", { responseId: result.details.responseId, urlIndex: 0 })).content[0].text
					: undefined;
				results.push({ text: result.content.map((part) => part.text).join("\\n"), isError: result.isError, details: result.details, structured: result.structuredContent, stored });
			}
			console.log(JSON.stringify({ results, clairicRequests, pageFetches, today, properties: Object.keys(fetchTool.parameters.properties), modes: fetchTool.parameters.properties.mode.enum, promptSnippet: fetchTool.promptSnippet }));
		`,
		encoding: "utf8",
		env,
	});
	if (fails) return child;
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

const clairic = (answers) => ({ body: { success: true, result: { model: "clairic", answers, truncated: false } } });

test("extract sends the page and mapped fields to Clairic and shows confident typed values", () => {
	const run = runFetch(extractConfig, [{ url: PAGE_A, mode: "extract", fields: { total: "number: Order total", items: "integer", wait: "duration.minutes", tags: "list", dates: "list.date" } }], {
		a: clairic({
			total: { type: "number", value: 42.1, confidence: 0.99 },
			items: { type: "number", value: 3, confidence: 0.98 },
			wait: { type: "duration", value: 95, confidence: 0.97 },
			tags: { type: "list", value: ["a", "b"], confidence: 0.95 },
			dates: { type: "list", value: ["2026-10-27"], confidence: 0.9 },
		}),
	});
	assert.ok(run.properties.includes("fields"));
	assert.ok(run.modes.includes("extract"));
	assert.equal(run.clairicRequests.length, 1);
	assert.equal(run.clairicRequests[0].url, CLAIRIC_URL);
	assert.equal(run.clairicRequests[0].authorization, `Bearer ${CF_TOKEN}`);
	assert.equal(run.clairicRequests[0].body, JSON.stringify({
		model: "clairic",
		state: "Alpha page. Order total $42.10.",
		fields: {
			total: { type: "number", instructions: "Order total" },
			items: { type: "number", integer: true },
			wait: { type: "duration", unit: "minutes" },
			tags: { type: "list", items: "text" },
			dates: { type: "list", items: "date" },
		},
		reference_date: run.today,
	}));
	const [result] = run.results;
	assert.match(result.text, /\ntotal: 42\.1 \(0\.99\) from "Alpha page\. Order total \$42\.10\."\nitems: 3 \(0\.98\)\nwait: 95 \(0\.97\)\ntags: \["a","b"\] \(0\.95\)\ndates: \["2026-10-27"\] \(0\.90\)\n/);
	assert.deepEqual(result.details.extractions[0].fields.total, { status: "extracted", value: 42.1, confidence: 0.99, line: "Alpha page. Order total $42.10." });
	// Codemode scripts get the same typed values as data, including the page line.
	assert.deepEqual(result.structured.urls[0].extraction.fields.total, { status: "extracted", value: 42.1, confidence: 0.99, line: "Alpha page. Order total $42.10." });
	assert.deepEqual([result.details.title, result.details.totalChars], ["a", "Alpha page. Order total $42.10.".length]);
	assert.doesNotMatch(result.text, /findText/);
});

test("low confidence, a wrong type, an impossible date or time, an empty or negative value, no confidence, and a missing value are never reported as extracted", () => {
	const run = runFetch(extractConfig, [{ url: PAGE_A, mode: "extract", fields: { invoice: "text", due: "date", items: "integer", shipped: "date", closes: "time", starts: "datetime", note: "text", wait: "duration.minutes", gate: "text", coupon: "text" } }], {
		a: clairic({
			invoice: { type: "text", value: "INV-1", confidence: 0.55 },
			due: { type: "date", value: "Oct 27", confidence: 0.99 },
			items: { type: "number", value: 2.5, confidence: 0.99 },
			shipped: { type: "date", value: "2026-13-45", confidence: 0.99 },
			closes: { type: "time", value: "25:00", confidence: 0.99 },
			starts: { type: "datetime", value: "2026-02-30T10:00", confidence: 0.99 },
			note: { type: "text", value: " ", confidence: 0.99 },
			wait: { type: "duration", value: -5, confidence: 0.99 },
			gate: { type: "text", value: "B12" },
			coupon: { type: "text", value: null, guess: "SAVE10", confidence: 0.99, p_null: 0.99 },
		}),
	});
	assert.match(run.results[0].text, /\ninvoice: uncertain \(guess INV-1, 0\.55\)\ndue: uncertain \(guess Oct 27, 0\.99\)\nitems: uncertain \(guess 2\.5, 0\.99\)\nshipped: uncertain \(guess 2026-13-45, 0\.99\)\ncloses: uncertain \(guess 25:00, 0\.99\)\nstarts: uncertain \(guess 2026-02-30T10:00, 0\.99\)\nnote: uncertain \(guess  , 0\.99\)\nwait: uncertain \(guess -5, 0\.99\)\ngate: uncertain \(guess B12\)\ncoupon: not on the page\n/);
	assert.match(run.results[0].text, /urlIndex follows the order above\. To check an uncertain value, add findText with its guess\.$/);
});

test("a PDF is extracted from its text, not from the saved-file notice", () => {
	const run = runFetch({ ...extractConfig, pdf: { provider: "unpdf" }, fetchRouting: { providers: ["http"] } }, [{ url: PAGE_PDF, mode: "extract", fields: { fee: "number" } }], {
		pdf: clairic({ fee: { type: "number", value: 42, confidence: 0.99 } }),
	});
	const { state } = JSON.parse(run.clairicRequests[0].body);
	assert.match(state, /The annual fee is 42 dollars\./);
	assert.doesNotMatch(state, /PDF extracted and saved/);
	assert.match(run.results[0].text, /\nfee: 42 \(0\.99\) from "The annual fee is 42 dollars\."\n/);
});

test("field names are plain keys, including __proto__", () => {
	assert.deepEqual(Object.keys(parseExtractFields(JSON.parse('{"__proto__":"number","constructor":"text"}'))), ["__proto__", "constructor"]);
});

test("invalid or misplaced fields, and auth with extract, fail before any page fetch or Clairic request", () => {
	const run = runFetch(extractConfig, [
		{ url: PAGE_A, mode: "extract", fields: { "bad name": "number" } },
		{ url: PAGE_A, mode: "extract", fields: { price: "money" } },
		{ url: PAGE_A, mode: "extract" },
		{ url: PAGE_A, mode: "readable", fields: { price: "number" } },
		{ url: PAGE_A, mode: "extract", fields: { price: "number" }, auth: true },
	]);
	assert.deepEqual(run.results.map((result) => result.text), [
		'Error: field name "bad name" must be 1 to 64 letters, digits, or underscores.',
		'Error: field price has unknown type "money"; use text, number, integer, date, time, datetime, duration, duration.<seconds|minutes|hours|days|weeks|months|years>, list, list.number, or list.date.',
		"Error: mode extract requires fields.",
		"Error: fields requires mode extract.",
		"Error: auth cannot be combined with mode extract.",
	]);
	assert.deepEqual([run.pageFetches, run.clairicRequests.length], [0, 0]);
});

test("a long value is cut on its own, and the whole result is cut at maxInlineContentChars", () => {
	const long = "word ".repeat(400).trim();
	const reply = { a: clairic({ note: { type: "text", value: long, confidence: 0.99 }, total: { type: "number", value: 7, confidence: 0.99 } }) };
	const run = runFetch(extractConfig, [{ url: PAGE_A, mode: "extract", fields: { note: "text", total: "number" } }], reply);
	// The text is not on the page, so it is also shown as uncertain.
	assert.match(run.results[0].text, /\nnote: uncertain \(guess (word ){200}… \[1999 characters; the rest is in the stored page\], 0\.99; not found on the page\)\ntotal: 7 \(0\.99\)\n/);
	assert.equal(run.results[0].details.extractions[0].fields.note.guess, long);
	const capped = runFetch({ ...extractConfig, maxInlineContentChars: 1000 }, [{ url: PAGE_A, mode: "extract", fields: { note: "text", total: "number" } }], reply);
	assert.match(capped.results[0].text, /\[Results cut at 1000 characters; ask for fewer fields or URLs\.\]/);
});

test("a failed extraction is shown per page without the credential, and the fetched pages stay stored", () => {
	const run = runFetch(extractConfig, [{ urls: [PAGE_A, PAGE_B], mode: "extract", fields: { total: "number" } }], {
		a: { status: 500, body: `${"x".repeat(190)}${CF_TOKEN} tail` },
		b: clairic({ total: { type: "number", value: null, guess: null, confidence: 0.99 } }),
	});
	const [result] = run.results;
	assert.match(result.text, /\nExtraction failed: Cloudflare Workers AI returned HTTP 500: x{190}\[redacted\]\n/);
	assert.match(result.text, /\ntotal: not on the page\n/);
	assert.ok(![result.text, JSON.stringify(result.details)].some((output) => output.includes(CF_TOKEN.slice(0, 10))));
	assert.equal(result.isError, undefined);
	assert.equal(result.details.successful, 2);
	assert.deepEqual(result.structured.urls.map((entry) => [entry.error, entry.extraction]), [
		[null, { error: "Cloudflare Workers AI returned HTTP 500: " + "x".repeat(190) + "[redacted]" }],
		[null, { fields: { total: { status: "null" } }, cut: false }],
	]);
	assert.match(result.stored, /Alpha page\. Order total \$42\.10\./);
});

test("without Cloudflare set up in Pi each page reports it and Clairic is not called", () => {
	const run = runFetch(extractConfig, [{ url: PAGE_A, mode: "extract", fields: { total: "number" } }], {}, { setUp: false });
	const [result] = run.results;
	assert.match(result.text, /\nExtraction failed: Cloudflare Workers AI is not set up in Pi; set CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID\n/);
	assert.deepEqual([run.pageFetches, run.clairicRequests.length], [1, 0]);
	assert.equal(result.isError, undefined);
	assert.match(result.stored, /Alpha page/);
});

test("extract is offered only when fetch.allowedModes lists it, and cannot be the default mode", () => {
	const byDefault = runFetch(undefined, [{ url: PAGE_A, mode: "extract", fields: { total: "number" } }]);
	assert.ok(!byDefault.properties.includes("fields"));
	assert.doesNotMatch(byDefault.promptSnippet, /extract/);
	assert.match(runFetch(extractConfig, []).promptSnippet, /For specific values .* use mode "extract" with fields/);
	assert.match(byDefault.results[0].text, /Fetch mode "extract" is disabled by fetch\.allowedModes/);
	assert.deepEqual([byDefault.pageFetches, byDefault.clairicRequests.length], [0, 0]);
	const asDefault = runFetch({ fetch: { allowedModes: ["extract"], defaultMode: "extract" } }, [], {}, { fails: true });
	assert.notEqual(asDefault.status, 0);
	assert.match(asDefault.stderr, /fetch\.defaultMode in .*web-search\.json cannot be "extract"/);
});

const setUpRegistry = { async getProviderAuth() { return { auth: { apiKey: CF_TOKEN }, env: { CLOUDFLARE_ACCOUNT_ID: "acct-1" } }; } };

test("a page over 200,000 characters is cut before it is sent, and the result says so", async (t) => {
	let state;
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		state = JSON.parse(init.body).state;
		return Response.json({ success: true, result: { answers: { total: { type: "number", value: 1, confidence: 0.99 } }, truncated: false } });
	});
	const result = await extractPageFields("x".repeat(200_001), { total: { type: "number" } }, { modelRegistry: setUpRegistry });
	assert.equal(state.length, 200_000);
	assert.equal(result.cut, true);
});

test("a caller abort during extraction rejects instead of becoming a per-page error", async (t) => {
	const controller = new AbortController();
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		controller.abort();
		init.signal.throwIfAborted();
	});
	await assert.rejects(extractPageFields("Alpha", { total: { type: "number" } }, { modelRegistry: setUpRegistry }, controller.signal), { name: "AbortError" });
});

test("with an AI Gateway id in Pi, Clairic is called through that gateway", async (t) => {
	const gateways = [];
	t.mock.method(globalThis, "fetch", async (_url, init) => {
		gateways.push(init.headers["cf-aig-gateway-id"]);
		return Response.json({ success: true, result: { answers: { total: { type: "number", value: 1, confidence: 0.99 } } } });
	});
	const withGateway = { async getProviderAuth(provider) { return provider === "cloudflare-ai-gateway" ? { auth: {}, env: { CLOUDFLARE_GATEWAY_ID: "team-gw" } } : setUpRegistry.getProviderAuth(); } };
	await extractPageFields("Alpha", { total: { type: "number" } }, { modelRegistry: withGateway });
	await extractPageFields("Alpha", { total: { type: "number" } }, { modelRegistry: setUpRegistry });
	assert.deepEqual(gateways, ["team-gw", undefined]);
});

test("text and numbers cite the page line they are on, and text that is not on the page is uncertain", async (t) => {
	const page = "# Plans\nPro: $1,299 per year, billed annually.\nRelease v5.3.1 ships **Acme  Pro** today.\nNext review: 2026-11-02.";
	t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, result: { answers: {
		plan: { type: "text", value: "acme pro", confidence: 0.99 },
		coupon: { type: "text", value: "SAVE10", confidence: 0.99 },
		yearly: { type: "number", value: 1299, confidence: 0.99 },
		minor: { type: "number", value: 3, confidence: 0.99 },
		review: { type: "date", value: "2026-11-02", confidence: 0.99 },
	} } }));
	const fields = parseExtractFields({ plan: "text", coupon: "text", yearly: "number", minor: "integer", review: "date" });
	const result = await extractPageFields(page, fields, { modelRegistry: setUpRegistry });
	assert.deepEqual(result.fields, {
		plan: { status: "extracted", value: "acme pro", confidence: 0.99, line: "Release v5.3.1 ships **Acme Pro** today." },
		coupon: { status: "uncertain", guess: "SAVE10", confidence: 0.99, notFound: true },
		yearly: { status: "extracted", value: 1299, confidence: 0.99, line: "Pro: $1,299 per year, billed annually." },
		// "3" inside "v5.3.1" is part of a longer number, and a number match never changes the status.
		minor: { status: "extracted", value: 3, confidence: 0.99 },
		review: { status: "extracted", value: "2026-11-02", confidence: 0.99 },
	});
});

test("text is found through Turndown's markdown escapes and links", async (t) => {
	const { default: TurndownService } = await import("turndown");
	const page = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
		.turndown('<p>Install my_package_name and set the [beta] flag.</p><p>See the <a href="https://example.com/docs">setup guide</a> — it’s short.</p>');
	t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, result: { answers: {
		pkg: { type: "text", value: "my_package_name", confidence: 0.99 },
		flag: { type: "text", value: "[beta]", confidence: 0.99 },
		guide: { type: "text", value: "setup guide - it's short", confidence: 0.99 },
	} } }));
	const result = await extractPageFields(page, parseExtractFields({ pkg: "text", flag: "text", guide: "text" }), { modelRegistry: setUpRegistry });
	assert.deepEqual(Object.values(result.fields).map((field) => [field.status, field.line]), [
		["extracted", "Install my\\_package\\_name and set the \\[beta\\] flag."],
		["extracted", "Install my\\_package\\_name and set the \\[beta\\] flag."],
		["extracted", "See the [setup guide](https://example.com/docs) — it’s short."],
	]);
});

test("a value made of emphasis characters against a long run of them is checked without stalling", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, result: { answers: { total: { type: "text", value: "Total _ _ due", confidence: 0.99 } } } }));
	// A regex built from the value backtracked for seconds on 4,000 underscores.
	const page = `Total ${"_".repeat(100_000)} paid`;
	const result = await extractPageFields(page, parseExtractFields({ total: "text" }), { modelRegistry: setUpRegistry });
	assert.equal(result.fields.total.status, "uncertain");
});

test("a link's target and an image's address are found, as well as the link text", async (t) => {
	const { default: TurndownService } = await import("turndown");
	const page = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
		.turndown('<p>Get it from <a href="https://example.com/file_v2.zip">the download page</a>.</p><p><img src="https://cdn.example.com/logo.png" alt="Logo"></p>');
	t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, result: { answers: {
		download: { type: "text", value: "https://example.com/file_v2.zip", confidence: 0.99 },
		logo: { type: "text", value: "https://cdn.example.com/logo.png", confidence: 0.99 },
		label: { type: "text", value: "the download page.", confidence: 0.99 },
	} } }));
	const result = await extractPageFields(page, parseExtractFields({ download: "text", logo: "text", label: "text" }), { modelRegistry: setUpRegistry });
	assert.deepEqual(Object.values(result.fields).map((field) => [field.status, field.line]), [
		["extracted", "Get it from [the download page](https://example.com/file_v2.zip)."],
		["extracted", "![Logo](https://cdn.example.com/logo.png)"],
		["extracted", "Get it from [the download page](https://example.com/file_v2.zip)."],
	]);
});
