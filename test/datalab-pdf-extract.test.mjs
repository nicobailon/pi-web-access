import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalKey = process.env.DATALAB_API_KEY;
const originalMode = process.env.DATALAB_MODE;
const originalLocation = process.env.DATALAB_PROCESSING_LOCATION;
const originalBase = process.env.DATALAB_API_BASE;
process.env.DATALAB_API_KEY = "synthetic-datalab-key";

const { extractPDFViaDatalab, getDatalabApiBase } = await import(
	"../datalab-pdf-extract.ts"
);

after(() => {
	globalThis.fetch = originalFetch;
	restoreEnv("DATALAB_API_KEY", originalKey);
	restoreEnv("DATALAB_MODE", originalMode);
	restoreEnv("DATALAB_PROCESSING_LOCATION", originalLocation);
	restoreEnv("DATALAB_API_BASE", originalBase);
});

test("Datalab conversion uploads the PDF, converts with a datalab reference, and polls to completion", async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return route(url, init);
	};

	const input = Uint8Array.from([1, 2, 3, 4]).buffer;
	const result = await extractPDFViaDatalab(input, {
		maxPages: 5,
		title: "Sample Document",
	});

	const byUrl = calls.map((call) => call.url);
	assert.equal(byUrl.filter((url) => url.endsWith("/files/upload")).length, 1);
	assert.equal(byUrl.filter((url) => url.includes("/put/")).length, 1);
	assert.equal(
		byUrl.filter((url) => url.endsWith("/files/7/confirm")).length,
		1,
	);
	assert.equal(byUrl.filter((url) => url.endsWith("/convert")).length, 1);
	assert.equal(byUrl.filter((url) => url.endsWith("/check/abc123")).length, 1);

	const upload = calls.find((call) => call.url.endsWith("/files/upload"));
	assert.equal(
		new Headers(upload.init.headers).get("x-api-key"),
		"synthetic-datalab-key",
	);
	assert.equal(
		new Headers(upload.init.headers).get("content-type"),
		"application/json",
	);
	const uploadBody = parseJsonBody(upload.init.body);
	assert.ok(uploadBody, "upload body did not parse");
	assert.equal(uploadBody.filename, "sample-document.pdf");
	assert.equal(uploadBody.content_type, "application/pdf");
	assert.equal(uploadBody.processing_location, "us");

	const put = calls.find((call) => call.url.includes("/put/"));
	assert.equal(put.init.method, "PUT");
	assert.equal(
		new Headers(put.init.headers).get("content-type"),
		"application/pdf",
	);

	const convert = calls.find((call) => call.url.endsWith("/convert"));
	assert.equal(convert.init.method, "POST");
	assert.equal(
		new Headers(convert.init.headers).get("x-api-key"),
		"synthetic-datalab-key",
	);
	const body = convert.init.body;
	assert.ok(body instanceof FormData);
	assert.equal(body.get("file_url"), "datalab://file-7");
	assert.equal(body.get("output_format"), "markdown");
	assert.equal(body.get("paginate"), "true");
	assert.equal(body.get("max_pages"), "5");
	assert.equal(body.get("mode"), "balanced");
	assert.equal(body.get("processing_location"), null);

	const cleanup = calls.find(
		(call) => call.url.endsWith("/files/7") && call.init.method === "DELETE",
	);
	assert.ok(cleanup, "expected best-effort file cleanup after conversion");

	assert.match(result.markdown, /^<!-- Page 1 -->/);
	assert.equal(result.pages, 2);
	assert.equal(result.parseQualityScore, 4.5);
});

test("Datalab conversion still succeeds when cleanup fails", async () => {
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/files/7") && init.method === "DELETE") {
			throw new Error("cleanup transport failure");
		}
		return route(url, init);
	};

	const result = await extractPDFViaDatalab(new ArrayBuffer(1), {
		maxPages: 1,
		title: "Doc",
	});
	assert.match(result.markdown, /Sample Document/);
});

test("Datalab conversion honors processing location and mode selection", async () => {
	let capturedLocation = null;
	let capturedMode = null;
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/files/upload")) {
			capturedLocation = parseJsonBody(init.body)?.processing_location ?? null;
			return jsonResponse({
				file_id: 7,
				upload_url: "https://storage.test/put/abc",
				reference: "datalab://file-7",
			});
		}
		if (String(url).endsWith("/convert")) {
			const body = init.body;
			capturedMode = body.get("mode");
			return jsonResponse({
				status: "complete",
				success: true,
				markdown: "<!-- Page 1 -->\nDone",
				page_count: 1,
			});
		}
		return route(url, init);
	};

	process.env.DATALAB_PROCESSING_LOCATION = "eu";
	process.env.DATALAB_MODE = "accurate";
	await extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 2, title: "Doc" });

	assert.equal(capturedLocation, "eu");
	assert.equal(capturedMode, "accurate");
	delete process.env.DATALAB_PROCESSING_LOCATION;
	delete process.env.DATALAB_MODE;
});

test("Datalab conversion rejects a missing file_id before uploading", async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		if (String(url).endsWith("/files/upload")) {
			return jsonResponse({
				upload_url: "https://storage.test/put/abc",
				reference: "datalab://file-7",
			});
		}
		return route(url, init);
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/missing file_id/,
	);
	assert.equal(
		calls.some((url) => url.includes("/put/")),
		false,
		"must not upload without a file ID for confirmation and cleanup",
	);
});

test("Datalab conversion returns immediately when the convert response is complete", async () => {
	let convertCalls = 0;
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/convert")) {
			convertCalls += 1;
			return jsonResponse({
				status: "complete",
				success: true,
				markdown: "<!-- Page 1 -->\nFast",
				page_count: 1,
			});
		}
		return route(url, init);
	};

	const result = await extractPDFViaDatalab(new ArrayBuffer(1), {
		maxPages: 1,
		title: "Doc",
	});
	assert.equal(convertCalls, 1);
	assert.match(result.markdown, /Fast/);
});

test("Datalab conversion rejects HTTP errors with the status and redacted body", async () => {
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/files/upload")) {
			return new Response(JSON.stringify({ detail: "invalid api key" }), {
				status: 401,
				statusText: "Unauthorized",
				headers: { "content-type": "application/json" },
			});
		}
		return route(url, init);
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/HTTP 401 Unauthorized: .*invalid api key/,
	);
});

test("Datalab conversion redacts API keys from transport errors", async () => {
	globalThis.fetch = async () => {
		throw new Error("network failure for synthetic-datalab-key");
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		(error) => {
			assert.equal(error.name, "Error");
			assert.doesNotMatch(error.message, /synthetic-datalab-key/);
			return true;
		},
	);
});

test("Datalab conversion rejects a streamed response above its byte limit", async () => {
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/files/upload")) {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}
		return route(url, init);
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/response too large/,
	);
});

test("Datalab conversion rejects failed conversion status", async () => {
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/convert")) {
			return jsonResponse({
				status: "processing",
				request_check_url: "/check/abc",
			});
		}
		if (String(url).endsWith("/check/abc")) {
			return jsonResponse({
				status: "failed",
				success: false,
				error: "document is corrupt",
			});
		}
		return route(url, init);
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/document is corrupt/,
	);
});

test("Datalab conversion rejects empty markdown", async () => {
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/convert")) {
			return jsonResponse({
				status: "complete",
				success: true,
				markdown: "   ",
				page_count: 1,
			});
		}
		return route(url, init);
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/empty markdown/,
	);
});

test("Datalab conversion times out while polling without waiting a full poll interval", async () => {
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/convert")) {
			return jsonResponse({
				status: "processing",
				request_check_url: "/check/abc",
			});
		}
		if (String(url).endsWith("/check/abc")) {
			return jsonResponse({ status: "processing" });
		}
		return route(url, init);
	};

	const started = Date.now();
	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), {
			maxPages: 1,
			title: "Doc",
			timeoutMs: 60,
		}),
		/timed out/,
	);
	assert.ok(
		Date.now() - started < 500,
		"polling must not delay a 60ms timeout by its 1.5s interval",
	);
});

test("Datalab cancellation returns without awaiting best-effort cleanup", async () => {
	const controller = new AbortController();
	let markConvertSubmitted;
	const convertSubmitted = new Promise((resolve) => {
		markConvertSubmitted = resolve;
	});
	let markCleanupStarted;
	const cleanupStarted = new Promise((resolve) => {
		markCleanupStarted = resolve;
	});
	let finishCleanup;
	const cleanupBlocked = new Promise((resolve) => {
		finishCleanup = resolve;
	});

	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/convert")) markConvertSubmitted();
		if (String(url).endsWith("/files/7") && init.method === "DELETE") {
			markCleanupStarted();
			return cleanupBlocked;
		}
		return route(url, init);
	};

	const extraction = extractPDFViaDatalab(new ArrayBuffer(1), {
		maxPages: 1,
		title: "Doc",
		signal: controller.signal,
	});
	await convertSubmitted;
	controller.abort(new DOMException("cancelled", "AbortError"));
	await cleanupStarted;

	const outcome = await settlesWithin(extraction, 100);
	assert.equal(outcome.status, "rejected");
	assert.equal(outcome.error.name, "AbortError");
	finishCleanup(new Response(null, { status: 200 }));
});

test("Datalab conversion rejects a cross-origin polling URL", async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		if (String(url).endsWith("/convert")) {
			return jsonResponse({
				status: "processing",
				request_check_url: "https://untrusted.example.test/check/abc",
			});
		}
		return route(url, init);
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/unexpected origin/,
	);
	assert.equal(
		calls.some((url) => url.includes("untrusted.example.test")),
		false,
		"must not send the API key to a polling URL returned by another origin",
	);
});

test("Datalab conversion surfaces missing request_check_url", async () => {
	globalThis.fetch = async (url, init) => {
		if (String(url).endsWith("/convert")) {
			return jsonResponse({ status: "processing" });
		}
		return route(url, init);
	};

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/missing request_check_url/,
	);
});

test("Datalab conversion honors a custom API base", async () => {
	process.env.DATALAB_API_BASE = "https://datalab.example.test/api/v1";
	const seen = [];
	globalThis.fetch = async (url, init) => {
		seen.push(String(url));
		if (String(url).endsWith("/check/abc123")) {
			return jsonResponse({
				status: "complete",
				success: true,
				markdown: "<!-- Page 1 -->\nCustom",
				page_count: 1,
			});
		}
		return route(url, init);
	};

	assert.equal(getDatalabApiBase(), "https://datalab.example.test/api/v1");
	const result = await extractPDFViaDatalab(new ArrayBuffer(1), {
		maxPages: 1,
		title: "Doc",
	});
	assert.match(result.markdown, /Custom/);
	assert.ok(
		seen.some((url) =>
			url.startsWith("https://datalab.example.test/api/v1/files/upload"),
		),
	);
	assert.ok(
		seen.some((url) =>
			url.startsWith("https://datalab.example.test/api/v1/convert"),
		),
	);
	delete process.env.DATALAB_API_BASE;
});

test("Datalab conversion preserves caller cancellation", async () => {
	const controller = new AbortController();
	controller.abort(new DOMException("cancelled", "AbortError"));

	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), {
			maxPages: 1,
			title: "Doc",
			signal: controller.signal,
		}),
		(error) => error instanceof DOMException && error.name === "AbortError",
	);
});

test("Datalab conversion rejects invalid processing location env", async () => {
	process.env.DATALAB_PROCESSING_LOCATION = "mars";
	await assert.rejects(
		extractPDFViaDatalab(new ArrayBuffer(1), { maxPages: 1, title: "Doc" }),
		/Failed to parse DATALAB_PROCESSING_LOCATION/,
	);
	delete process.env.DATALAB_PROCESSING_LOCATION;
});

function route(url) {
	const urlString = String(url);
	if (urlString.endsWith("/files/upload")) {
		return jsonResponse({
			file_id: 7,
			upload_url: "https://storage.test/put/abc",
			reference: "datalab://file-7",
			expires_in: 3600,
		});
	}
	if (urlString.includes("/put/")) {
		return new Response(null, { status: 200 });
	}
	if (urlString.endsWith("/files/7/confirm")) {
		return jsonResponse({
			file_id: 7,
			reference: "datalab://file-7",
			message: "confirmed",
		});
	}
	if (urlString.endsWith("/files/7")) {
		return new Response(null, { status: 200 });
	}
	if (urlString.endsWith("/convert")) {
		return jsonResponse({
			status: "processing",
			request_check_url: "/check/abc123",
		});
	}
	if (urlString.endsWith("/check/abc123")) {
		return jsonResponse({
			status: "complete",
			success: true,
			markdown:
				"<!-- Page 1 -->\n# Sample Document\n\nFirst page.\n\n<!-- Page 2 -->\n\nSecond page.",
			page_count: 2,
			parse_quality_score: 4.5,
			cost_breakdown: { total_cost_cents: 1 },
		});
	}
	return new Response(
		JSON.stringify({ detail: "unexpected fetch: " + urlString }),
		{
			status: 418,
			headers: { "content-type": "application/json" },
		},
	);
}

function parseJsonBody(value) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function jsonResponse(value) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function settlesWithin(promise, timeoutMs) {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
		promise.then(
			() => {
				clearTimeout(timeout);
				resolve({ status: "resolved" });
			},
			(error) => {
				clearTimeout(timeout);
				resolve({ status: "rejected", error });
			},
		);
	});
}

function restoreEnv(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
