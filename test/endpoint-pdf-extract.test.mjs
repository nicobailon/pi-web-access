import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.PDF_ENDPOINT_URL;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

// Isolate before import: the module resolves its config path at import time,
// so a developer machine's real web-search.json must not leak into any case.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-endpoint-pdf-"));

const {
	extractPDFViaEndpoint,
	getEndpointUrl,
	isEndpointApiAvailable,
} = await import("../endpoint-pdf-extract.ts");

after(() => {
	globalThis.fetch = originalFetch;
	if (originalUrl === undefined) delete process.env.PDF_ENDPOINT_URL;
	else process.env.PDF_ENDPOINT_URL = originalUrl;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3]).buffer;
const LOOKUP_PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

function useEndpoint(url) {
	if (url === undefined) delete process.env.PDF_ENDPOINT_URL;
	else process.env.PDF_ENDPOINT_URL = url;
}

test("endpoint URL resolves from PDF_ENDPOINT_URL and pdf.endpointUrl is unset by default", () => {
	useEndpoint(undefined);
	assert.equal(getEndpointUrl(), null);
	assert.equal(isEndpointApiAvailable(), false);
	useEndpoint("http://192.168.50.48:8070/parse/");
	assert.equal(getEndpointUrl(), "http://192.168.50.48:8070/parse");
	assert.equal(isEndpointApiAvailable(), true);
});

test("a non-http endpoint URL is a fatal config error", () => {
	useEndpoint("ftp://parser.local/parse");
	assert.throws(() => getEndpointUrl(), /Failed to parse pdf\.endpointUrl/);
	useEndpoint("not a url");
	assert.throws(() => getEndpointUrl(), /Failed to parse pdf\.endpointUrl/);
});

test("extractPDFViaEndpoint posts the PDF as multipart file and returns markdown", async () => {
	useEndpoint("http://parser.test/parse");
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ engine: "marker", markdown: "# Parsed\n\n\x00m\x00arkdown body" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const result = await extractPDFViaEndpoint(PDF_BYTES, {
		maxPages: 10,
		lookup: LOOKUP_PUBLIC,
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "http://parser.test/parse");
	assert.equal(calls[0].init.method, "POST");
	assert.ok(calls[0].init.body instanceof FormData);
	const file = calls[0].init.body.get("file");
	assert.ok(file, "multipart body did not carry a file field");
	assert.equal(file.type, "application/pdf");
	// the page cap travels to the parser as its own form field, as with Datalab
	assert.equal(calls[0].init.body.get("max_pages"), "10");
	// broken-encoding NUL bytes are stripped from parser output
	assert.equal(result.markdown, "# Parsed\n\nmarkdown body");
});

test("extractPDFViaEndpoint refuses redirects from the parser onto blocked hosts", async () => {
	useEndpoint("http://parser.test/parse");
	globalThis.fetch = async (url) => {
		if (String(url) === "http://parser.test/parse") {
			return new Response(null, { status: 307, headers: { location: "http://pivot.internal/parse" } });
		}
		throw new Error(`redirect target must never be fetched: ${url}`);
	};
	const lookup = async (hostname) =>
		hostname === "parser.test"
			? [{ address: "93.184.216.34", family: 4 }]
			: [{ address: "10.0.0.5", family: 4 }];
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 10, lookup }),
		/Blocked internal address/i,
	);
});

test("extractPDFViaEndpoint cancels oversized JSON responses while streaming", async () => {
	useEndpoint("http://parser.test/parse");
	let cancelled = false;
	globalThis.fetch = async () => {
		const chunk = new Uint8Array(8 * 1024 * 1024);
		let sent = 0;
		return new Response(
			new ReadableStream({
				pull(controller) {
					if (sent++ >= 4) return controller.close();
					controller.enqueue(chunk);
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 10, lookup: LOOKUP_PUBLIC }),
		/oversized response/i,
	);
	assert.ok(cancelled, "response body was not cancelled at the size cap");
});

test("extractPDFViaEndpoint polls job responses until done", async () => {
	useEndpoint("http://parser.test/parse");
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method ?? "GET" });
		if (calls.length === 1) {
			return new Response(JSON.stringify({ job_id: "abc123", note: "running async" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (!String(url).endsWith("/jobs/abc123")) {
			throw new Error(`unexpected poll url ${url}`);
		}
		if (calls.length === 2) {
			return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
		}
		return new Response(
			JSON.stringify({ status: "done", result: { engine: "marker", markdown: "# Job done", pages: 3 } }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const result = await extractPDFViaEndpoint(PDF_BYTES, {
		maxPages: 10,
		timeoutMs: 15_000,
		lookup: LOOKUP_PUBLIC,
	});
	assert.equal(result.markdown, "# Job done");
	assert.equal(result.pages, 3);
	assert.equal(calls[1].url, "http://parser.test/jobs/abc123");
	assert.equal(calls[1].method, "GET");
});

test("extractPDFViaEndpoint reports endpoint errors and failed jobs", async () => {
	useEndpoint("http://parser.test/parse");
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ error: "llama-server binary not found" }), {
			status: 500,
			statusText: "Internal Server Error",
			headers: { "content-type": "application/json" },
		});
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, lookup: LOOKUP_PUBLIC }),
		/HTTP 500.*llama-server binary not found/s,
	);
	// an error body larger than the preview cap, sent as one chunk, keeps its prefix
	globalThis.fetch = async () => new Response(`upstream parser crashed: ${"x".repeat(600)}`, { status: 502 });
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, lookup: LOOKUP_PUBLIC }),
		/HTTP 502: upstream parser crashed: x+$/,
	);
	// an error body that fills the preview exactly and then stalls still fails fast
	globalThis.fetch = async () => new Response(
		new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`stalled: ${"y".repeat(291)}`)); } }),
		{ status: 502 },
	);
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, lookup: LOOKUP_PUBLIC, timeoutMs: 2_000 }),
		/HTTP 502: stalled: y+$/,
	);
});

test("malformed job results fail so the provider chain can fall back", async () => {
	useEndpoint("http://parser.test/parse");
	const respond = (result) => async (url) => {
		if (!String(url).includes("/jobs/")) {
			return new Response(JSON.stringify({ job_id: "j1" }), { status: 200 });
		}
		return new Response(JSON.stringify({ status: "done", result }), { status: 200 });
	};
	// a JSON-string result carrying an empty markdown field is a parser error,
	// NOT raw markdown to save
	globalThis.fetch = respond(JSON.stringify({ markdown: "" }));
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, lookup: LOOKUP_PUBLIC }),
		/returned no markdown/i,
	);
	// genuinely non-JSON result strings remain raw markdown
	globalThis.fetch = respond("# plain markdown");
	const raw = await extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, lookup: LOOKUP_PUBLIC });
	assert.equal(raw.markdown, "# plain markdown");
});

test("parser output that is only NUL bytes fails instead of saving empty text", async () => {
	useEndpoint("http://parser.test/parse");
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ markdown: "\x00\x00\x00" }), { status: 200 });
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, lookup: LOOKUP_PUBLIC }),
		/returned no markdown/i,
	);
});

test("extractPDFViaEndpoint aborts poll waits on caller cancellation", async () => {
	useEndpoint("http://parser.test/parse");
	const controller = new AbortController();
	globalThis.fetch = async (url) => {
		if (!String(url).includes("/jobs/")) {
			return new Response(JSON.stringify({ job_id: "slow" }), { status: 200 });
		}
		return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
	};
	const pending = extractPDFViaEndpoint(PDF_BYTES, {
		maxPages: 1,
		timeoutMs: 60_000,
		signal: controller.signal,
		lookup: LOOKUP_PUBLIC,
	});
	setTimeout(() => controller.abort(), 50);
	await assert.rejects(pending, { name: "AbortError" });
});

test("extractPDFViaEndpoint refuses parser hosts outside the SSRF policy", async () => {
	useEndpoint("http://10.0.0.9:8070/parse");
	globalThis.fetch = async () => {
		throw new Error("fetch must not be attempted");
	};
	await assert.rejects(
		extractPDFViaEndpoint(PDF_BYTES, { maxPages: 1, lookup: LOOKUP_PUBLIC }),
		/Blocked internal address/i,
	);
});
