import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The config path is captured at module load, so configured cases run in a child
// process with PI_CODING_AGENT_DIR pointed at a fresh temp dir.
async function fetchWithConfig(config, mode) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-user-agent-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config), "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const userAgents = [];
			globalThis.fetch = async (_url, init) => {
				userAgents.push(new Headers(init.headers).get("user-agent"));
				return new Response("body", { headers: { "content-type": "text/plain" } });
			};
			const { extractContent } = await import(${JSON.stringify(new URL("../extract.ts", import.meta.url).href)});
			const result = await extractContent("https://example.com/article", undefined, { mode: ${JSON.stringify(mode)}, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ userAgents, error: result.error }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("local HTTP fetch sends a configured fetchContent.userAgent", async () => {
	const browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
	const output = await fetchWithConfig({ fetchContent: { userAgent: ` ${browser} ` } }, "raw");
	assert.deepEqual(output, { userAgents: [browser], error: null });
});

test("an invalid fetchContent.userAgent fails the fetch before the direct fetch or any fallback provider", async () => {
	for (const userAgent of ["", "  ", "agent\nInjected: 1", "agent\u0000x", "agent 😀", 42]) {
		const output = await fetchWithConfig({ fetchContent: { userAgent }, fetchRouting: { allowRemoteHostedProviders: true } }, "readable");
		assert.deepEqual(output.userAgents, [], JSON.stringify(userAgent));
		assert.match(output.error, /^fetchContent\.userAgent in .*web-search\.json must be a non-empty string of printable ASCII characters$/);
	}
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

test("readable mode extracts Markdown from a mixed-case HTML content type", async () => {
	const article = `<html><head><title>Guide</title></head><body><article><h1>Guide</h1>${"<p>The full guide explains every <strong>configuration</strong> option in detail.</p>".repeat(20)}</article></body></html>`;
	globalThis.fetch = async () => new Response(article, { headers: { "content-type": "Text/HTML; charset=UTF-8" } });

	const result = await extractContent("https://example.com/guide", undefined, { lookup });
	assert.equal(result.error, null);
	assert.equal(result.title, "Guide");
	assert.match(result.content, /explains every \*\*configuration\*\* option/);
	assert.doesNotMatch(result.content, /<(?:html|article|p|strong)\b/i);
});

test("readable mode rejects mixed-case binary content types like lowercase", async () => {
	for (const contentType of ["application/zip", "Application/ZIP"]) {
		globalThis.fetch = async () => new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "content-type": contentType } });

		const result = await extractContent("https://example.com/archive", undefined, { lookup });
		assert.equal(result.error, "Unsupported content type: application/zip");
		assert.equal(result.content, "");
	}
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

const shortMarkdown = "# Changelog\n\n- 1.0 released";
const text = (body, type = "text/plain") => () => new Response(body, { headers: { "content-type": type } });

async function negotiate(normal, markdown = text(shortMarkdown, "text/markdown"), options = {}) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		return new Headers(init.headers).get("accept").startsWith("text/markdown") ? markdown() : normal();
	};
	const result = await extractContent("https://docs.example.com/changelog", undefined, { lookup, ...options });
	return { result, calls };
}

test("short negotiated markdown is kept only when the browser retry has no content", async () => {
	const { result: plain } = await negotiate(text("Plain changelog text"));
	assert.equal(plain.error, null);
	assert.equal(plain.content, "Plain changelog text");

	for (const [normal, status, retryError] of [
		[text(""), undefined, null],
		[() => new Response("", { headers: { "content-type": "text/markdown", link: '</openapi.json>; rel="service-desc"' } }), undefined, null],
		[() => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }), 503, "HTTP 503: Service Unavailable"],
	]) {
		const { result } = await negotiate(normal);
		assert.match(result.content, /1\.0 released/);
		assert.ok(result.error.startsWith("Extracted content appears incomplete" + (retryError ? `\nBrowser retry failed: ${retryError}` : "")));
		assert.equal(result.status, status);
	}

	const { result: empty } = await negotiate(text(""), text("", "text/markdown"));
	assert.equal(empty.error, null);
	assert.equal(empty.content, "");
});

test("authoritative browser retry failures replace short negotiated markdown", async () => {
	for (const [normal, error, expectedCalls] of [
		[() => new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "content-type": "application/zip" } }), /^Unsupported content type: application\/zip$/, 2],
		[() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }), /^Blocked internal/, 2],
		[() => new Response("gone", { status: 404, statusText: "Not Found" }), /HTTP 404/],
	]) {
		const { result, calls } = await negotiate(normal);
		assert.match(result.error, error);
		assert.doesNotMatch(result.content, /1\.0 released/);
		if (expectedCalls) assert.equal(calls.length, expectedCalls);
		else assert.equal(result.status, 404);
	}
});

test("short markdown served for every Accept header keeps its declared links", async () => {
	const withLink = () => new Response(shortMarkdown, { headers: { "content-type": "text/markdown", link: '</openapi.json>; rel="service-desc"' } });
	const { result, calls } = await negotiate(withLink, withLink);
	assert.equal(result.error, null);
	assert.match(result.content, /1\.0 released/);
	assert.match(result.content, /https:\/\/docs\.example\.com\/openapi\.json/);
	assert.equal(calls.length, 2);
});

test("caller abort during the browser retry returns an aborted result", async () => {
	const controller = new AbortController();
	globalThis.fetch = async (_url, init) => {
		if (new Headers(init.headers).get("accept").startsWith("text/markdown")) return text(shortMarkdown, "text/markdown")();
		controller.abort();
		throw new DOMException("This operation was aborted", "AbortError");
	};
	const result = await extractContent("https://docs.example.com/changelog", controller.signal, { lookup });
	assert.equal(result.error, "Aborted");
	assert.equal(result.content, "");
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
	assert.doesNotMatch(image.error, /retry without mode/);
	assert.equal(image.thumbnail, undefined);
});

test("raw mode rejects PDF bodies with a hint toward Markdown extraction", async () => {
	globalThis.fetch = async () => new Response("%PDF-1.4 junk", { headers: { "content-type": "application/pdf" } });

	const result = await extractContent("https://example.com/compatibility_list_AMD", undefined, { mode: "raw", lookup });
	assert.match(result.error, /Unsupported content type in raw mode: application\/pdf; retry without mode for Markdown, or with mode "answer"/);
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

test("readable mode accepts a complete short page and reports a partial extraction with counts", async () => {
	const fetchHtml = async (html) => {
		globalThis.fetch = async () => new Response(html, { headers: { "content-type": "text/html" } });
		return extractContent("https://example.com/page", undefined, { lookup });
	};

	const dataBlocks = '<script type="application/ld+json">{"@type":"Article"}</script>'.repeat(4) + '<script type="text/template"><p>row</p></script>';
	const short = await fetchHtml(`<html><head><title>Short Note</title>${dataBlocks}</head><body><h1>Short Note</h1><p>This page is intentionally short and complete.</p></body></html>`);
	assert.equal(short.error, null);
	assert.equal(short.title, "Short Note");
	assert.match(short.content, /intentionally short and complete/);

	const scripted = await fetchHtml('<html><head><title>Short Note</title><script src="/app.js"></script></head><body><h1>Short Note</h1><p>This page is intentionally short and complete.</p></body></html>');
	assert.match(scripted.error, /^Extracted content appears incomplete: the page has only \d+ characters of visible text and runs scripts/);
	const legacyType = await fetchHtml('<html><head><title>Short Note</title><script type="text/jscript" src="/app.js"></script></head><body><h1>Short Note</h1><p>This page is intentionally short and complete.</p></body></html>');
	assert.match(legacyType.error, /runs scripts/);

	const links = Array.from({ length: 40 }, (_, i) => `<li><a href="/section-${i}">Navigation section number ${i}</a></li>`).join("");
	const teaser = await fetchHtml(`<html><head><title>Teaser</title></head><body><nav><ul>${links}</ul></nav><article><h1>Teaser</h1><p>Only the first paragraph of this story is shown here.</p></article><footer><ul>${links}</ul></footer></body></html>`);
	assert.match(teaser.error, /^Extracted content appears incomplete: extracted 53 characters from a page with \d{4} characters of visible text/);
});
