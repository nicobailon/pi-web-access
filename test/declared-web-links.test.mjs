import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	appendDeclaredWebLinks,
	discoverDeclaredWebLinks,
} from "../declared-web-links.ts";

const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;

function runChild(script) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-declared-links-"));
	writeFileSync(
		join(home, "web-search.json"),
		JSON.stringify({ fetchRouting: { allowRemoteHostedProviders: true } }) +
			"\n",
		"utf8",
	);
	const childEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	};
	for (const key of [
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_API_KEY",
		"GOOGLE_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"CLOUDFLARE_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"FIRECRAWL_BASE_URL",
		"FIRECRAWL_API_KEY",
		"PI_ALLOW_BROWSER_COOKIES",
	])
		delete childEnv[key];
	try {
		return spawnSync(process.execPath, ["--input-type=module"], {
			input: script,
			encoding: "utf8",
			env: childEnv,
			maxBuffer: 2 * 1024 * 1024,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("discovers registered relations from Link headers and HTML declarations", () => {
	const { document } = parseHTML(`<!doctype html><html><head>
		<base href="/v2/">
		<link rel="stylesheet service-doc" href="docs" type="text/html">
		<link rel="alternate" href="/feed.xml">
	</head><body>
		<a rel="describedby" href="/schema">Schema</a>
		<a href="/developers">Developer careers</a>
		<a rel="service-desc" href="javascript:alert(1)">Unsafe</a>
	</body></html>`);
	const links = discoverDeclaredWebLinks(
		document,
		'</catalog>; title="API, <catalog>"; rel="API-CATALOG"; type="application/linkset+json", ' +
			'</schema>; rel="service-desc"; type="application/schema+json", ' +
			'</metadata>; rel="service-meta"; optional, ' +
			'</quoted>; title="x; rel=service-doc"; rel="alternate", ' +
			'</anchored>; rel="service-doc"; anchor="/other", ' +
			'</ignored>; rel="alternate"',
		"https://example.com/root/start",
	);

	assert.deepEqual(links, [
		{
			url: "https://example.com/catalog",
			relations: ["api-catalog"],
			type: "application/linkset+json",
		},
		{
			url: "https://example.com/schema",
			relations: ["service-desc", "describedby"],
			type: "application/schema+json",
		},
		{
			url: "https://example.com/metadata",
			relations: ["service-meta"],
		},
		{
			url: "https://example.com/v2/docs",
			relations: ["service-doc"],
			type: "text/html",
		},
	]);
});

test("bounds declarations while preserving their relation annotations", () => {
	const declarations = Array.from(
		{ length: 25 },
		(_, index) => `<link rel="service-doc" href="/docs/${index}">`,
	).join("");
	const { document } = parseHTML(`<html><head>${declarations}</head></html>`);
	const links = discoverDeclaredWebLinks(
		document,
		null,
		"https://example.com/",
	);
	assert.equal(links.length, 20);

	const oversized = discoverDeclaredWebLinks(
		parseHTML("<html></html>").document,
		`<https://example.com/${"x".repeat(4096)}>; rel="service-doc"`,
		"https://example.com/",
	);
	assert.deepEqual(oversized, []);

	const content = appendDeclaredWebLinks(
		"Existing: https://example.com/docs/0-extra",
		links.slice(0, 2),
	);
	assert.match(content, /<https:\/\/example\.com\/docs\/0>/);
	assert.match(content, /<https:\/\/example\.com\/docs\/1>/);
});

test("HTML extraction surfaces declared documentation links without broad URL heuristics", () => {
	const child = runChild(`
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const article = "Readable article content remains the primary result. ".repeat(20);
		const fixtures = {
			"https://example.com/readable": {
				html: \`<!doctype html><html><head><title>Readable</title></head><body><article><h1>Readable</h1><p>\${article}</p></article></body></html>\`,
				link: '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"',
			},
			"https://example.com/shell": {
				html: '<!doctype html><html><head><title>API shell</title><link rel="service-doc" href="/docs"></head><body><div id="app"></div></body></html>',
			},
			"https://example.com/fallback": {
				html: '<!doctype html><html><head><title>Rendered API</title></head><body><div id="app"></div></body></html>',
				link: '</openapi.json>; rel="service-desc"',
			},
			"https://example.com/generic": {
				html: '<!doctype html><html><head><title>Company</title></head><body><a href="/developers">Developer careers</a></body></html>',
			},
		};
		let calls = [];
		globalThis.fetch = async (input) => {
			const url = String(input);
			calls.push(url);
			if (url === "https://r.jina.ai/https://example.com/fallback") {
				return new Response("Title: Rendered API\\nMarkdown Content:\\n# Rendered API\\n\\n" + article, { status: 200 });
			}
			const fixture = fixtures[url];
			if (!fixture) return new Response("not available", { status: 404, statusText: "Not Found" });
			return new Response(fixture.html, {
				status: 200,
				headers: {
					"content-type": "text/html; charset=utf-8",
					...(fixture.link ? { link: fixture.link } : {}),
				},
			});
		};

		const readable = await extractContent("https://example.com/readable", undefined, { lookup });
		const readableCalls = calls.splice(0);
		const shell = await extractContent("https://example.com/shell", undefined, { lookup });
		const shellCalls = calls.splice(0);
		const fallback = await extractContent("https://example.com/fallback", undefined, { lookup });
		const fallbackCalls = calls.splice(0);
		const generic = await extractContent("https://example.com/generic", undefined, { lookup });
		console.log(JSON.stringify({ readable, readableCalls, shell, shellCalls, fallback, fallbackCalls, generic }));
	`);
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());

	assert.equal(output.readable.error, null);
	assert.match(output.readable.content, /Readable article content/);
	assert.match(output.readable.content, /## Declared links/);
	assert.match(output.readable.content, /service-desc/);
	assert.match(
		output.readable.content,
		/https:\/\/example\.com\/openapi\.json/,
	);
	assert.deepEqual(output.readableCalls, ["https://example.com/readable"]);

	assert.equal(output.shell.error, null);
	assert.match(output.shell.content, /service-doc/);
	assert.match(output.shell.content, /https:\/\/example\.com\/docs/);
	assert.deepEqual(output.shellCalls, [
		"https://example.com/shell",
		"https://r.jina.ai/https://example.com/shell",
	]);

	assert.equal(output.fallback.error, null);
	assert.match(output.fallback.content, /Rendered API/);
	assert.match(output.fallback.content, /service-desc/);
	assert.match(
		output.fallback.content,
		/https:\/\/example\.com\/openapi\.json/,
	);
	assert.deepEqual(output.fallbackCalls, [
		"https://example.com/fallback",
		"https://r.jina.ai/https://example.com/fallback",
	]);

	assert.doesNotMatch(
		output.generic.content,
		/https:\/\/example\.com\/developers/,
	);
	assert.ok(output.generic.error);
});
