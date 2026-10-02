import assert from "node:assert/strict";
import { after, test } from "node:test";

import { extractContent, fetchAllContent } from "../extract.ts";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("local HTTP fetch sends the compatible User-Agent", async () => {
	let userAgent;
	globalThis.fetch = async (_url, init) => {
		userAgent = new Headers(init.headers).get("user-agent");
		return new Response("body", { headers: { "content-type": "text/plain" } });
	};

	await extractContent("https://example.com/article", undefined, { mode: "raw", lookup });
	assert.equal(userAgent, "OpenAI File Downloader, XaiImageApiFetch/1.0");
});

test("readable fetch prefers server markdown while raw mode keeps the normal representation", async () => {
	const accepts = [];
	const markdown = `# Install Guide\n\n${"Run `npm install` and configure the project. ".repeat(15)}\n`;
	globalThis.fetch = async (_url, init) => {
		const accept = new Headers(init.headers).get("accept");
		accepts.push(accept);
		return accept.startsWith("text/markdown")
			? new Response(markdown, { headers: { "content-type": "text/markdown; charset=utf-8", link: '</openapi.json>; rel="service-desc"' } })
			: new Response("<html><body><p>html</p></body></html>", { headers: { "content-type": "text/html" } });
	};

	const readable = await extractContent("https://docs.example.com/install", undefined, { lookup });
	assert.equal(readable.error, null);
	assert.equal(readable.title, "Install Guide");
	assert.ok(readable.content.startsWith(markdown.trim()));
	assert.match(readable.content, /https:\/\/docs\.example\.com\/openapi\.json/);

	const raw = await extractContent("https://docs.example.com/install", undefined, { mode: "raw", lookup });
	assert.match(raw.content, /<p>html<\/p>/);
	assert.equal(accepts.length, 2);
	assert.doesNotMatch(accepts[1], /text\/markdown/);
	assert.match(accepts[1], /^text\/html/);
});

test("a near-empty negotiated markdown reply falls back to the page's HTML", async () => {
	const article = `<html><head><title>Guide</title></head><body><article><h1>Guide</h1>${"<p>The full guide explains every configuration option in detail.</p>".repeat(20)}</article></body></html>`;
	globalThis.fetch = async (_url, init) => new Headers(init.headers).get("accept").startsWith("text/markdown")
		? new Response("# Loading", { headers: { "content-type": "text/markdown" } })
		: new Response(article, { headers: { "content-type": "text/html" } });

	const result = await extractContent("https://spa.example.com/guide", undefined, { lookup });
	assert.equal(result.error, null);
	assert.match(result.content, /explains every configuration option/);
});

test("raw mode returns textual non-2xx bodies but rejects images", async () => {
	globalThis.fetch = async (url) => String(url).endsWith(".png")
		? new Response(png, { status: 200, headers: { "content-type": "image/png" } })
		: new Response('{"error":"missing"}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });

	const text = await extractContent("https://example.com/missing", undefined, { mode: "raw", lookup });
	assert.equal(text.error, null);
	assert.equal(text.status, 404);
	assert.equal(text.content, '{"error":"missing"}');

	const image = await extractContent("https://example.com/pixel.png", undefined, { mode: "raw", lookup });
	assert.match(image.error, /Unsupported content type in raw mode: image\/png/);
	assert.equal(image.thumbnail, undefined);
});

test("raw mode keeps data URIs in the exact HTTP body", async () => {
	const body = "exact data:text/plain,hello%20world body";
	globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/plain" } });

	const [result] = await fetchAllContent(["https://example.com/data"], undefined, { mode: "raw", lookup });
	assert.equal(result.content, body);
});

test("readable mode returns supported image content", async () => {
	globalThis.fetch = async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } });
	const result = await extractContent("https://example.com/pixel.png", undefined, { lookup });

	assert.equal(result.error, null);
	assert.equal(result.mimeType, "image/png");
	assert.equal(result.thumbnail?.mimeType, "image/png");
	assert.match(result.content, /Image fetched \(1×1, image\/png\)/);
});
