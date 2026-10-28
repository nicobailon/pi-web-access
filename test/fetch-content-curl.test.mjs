import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
const utilsUrl = new URL("../utils.ts", import.meta.url).href;

// A stand-in for curl: it logs its arguments and answers from FAKE_CURL_ROUTES the way
// the curl transport expects (-D header dump, --output body, %{json} write-out).
const fakeCurlDir = await mkdtemp(join(tmpdir(), "pi-fake-curl-"));
const fakeCurl = join(fakeCurlDir, "fake-curl.cjs");
await writeFile(fakeCurl, `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify(args) + "\\n");
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const url = args[args.length - 1];
const route = JSON.parse(process.env.FAKE_CURL_ROUTES)[url];
if (!route) { process.stderr.write("curl: (6) Could not resolve host"); process.exit(6); }
const headers = Object.entries(route.headers ?? {}).map(([name, value]) => name + ": " + value + "\\r\\n").join("");
fs.writeFileSync(valueAfter("-D"), "HTTP/2 " + route.status + "\\r\\n" + headers + "\\r\\n");
fs.writeFileSync(valueAfter("--output"), route.body ?? "");
process.stdout.write(JSON.stringify({ url_effective: url, num_redirects: 0 }));
if (route.exitCode) { process.stderr.write(route.stderr ?? ""); process.exitCode = route.exitCode; }
`);
after(() => rm(fakeCurlDir, { recursive: true, force: true }));

const curlCommand = [process.execPath, fakeCurl];
const textRoute = { status: 200, headers: { "content-type": "text/plain" }, body: "curl body" };

// The config path is read at module load, so each case runs in a child process with
// PI_CODING_AGENT_DIR pointed at a fresh config. Node's fetch is stubbed to record any use.
async function runExtract(config, { url = "https://example.com/article", options = {}, routes = { [url]: textRoute }, configuredProxyScope = false, env = {} } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-fetch-content-curl-"));
	const log = join(root, "curl-calls.jsonl");
	await writeFile(join(root, "web-search.json"), JSON.stringify(config));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const nodeFetches = [];
			globalThis.fetch = async (url, init) => {
				nodeFetches.push({ url: String(url), userAgent: new Headers(init?.headers).get("user-agent") });
				return new Response("node body", { headers: { "content-type": "text/plain" } });
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const { runWithProxy } = await import(${JSON.stringify(utilsUrl)});
			const run = () => extractContent(${JSON.stringify(url)}, undefined, { ...${JSON.stringify(options)}, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			const result = ${configuredProxyScope ? "await runWithProxy(undefined, run)" : "await run()"};
			console.log(JSON.stringify({ nodeFetches, result }));
		`,
		encoding: "utf8",
		env: { ...process.env, ...env, PI_CODING_AGENT_DIR: root, FAKE_CURL_LOG: log, FAKE_CURL_ROUTES: JSON.stringify(routes) },
	});
	try {
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim().split("\n").at(-1));
		const calls = await readFile(log, "utf8").then(
			(text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
			() => [],
		);
		return { ...output, calls };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function headerValues(args) {
	return args.flatMap((arg, index) => (arg === "-H" ? [args[index + 1]] : []));
}

test("fetchContent.curl sends the page fetch through the command without the default User-Agent", async () => {
	const output = await runExtract({ fetchContent: { curl: curlCommand } }, { options: { mode: "raw" } });
	assert.deepEqual(output.nodeFetches, []);
	assert.equal(output.calls.length, 1);
	const args = output.calls[0];
	assert.equal(args.at(-1), "https://example.com/article");
	// An empty -x keeps curl off proxy environment variables, as Node's fetch is.
	assert.equal(args[args.indexOf("-x") + 1], "", JSON.stringify(args));
	const headers = headerValues(args);
	assert.ok(!headers.some((header) => /^user-agent:/i.test(header)), JSON.stringify(headers));
	assert.ok(headers.some((header) => /^accept: text\/html/i.test(header)), JSON.stringify(headers));
	assert.equal(output.result.error, null);
	assert.equal(output.result.content, "curl body");
});

test("readable fetches through fetchContent.curl ask for markdown first and extract the page", async () => {
	const article = `<html><head><title>Curl Article</title></head><body><article><h1>Curl Article</h1><p>${"Readable text fetched through the configured curl command. ".repeat(20)}</p></article></body></html>`;
	const output = await runExtract({ fetchContent: { curl: curlCommand } }, {
		routes: { "https://example.com/article": { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: article } },
	});
	assert.deepEqual(output.nodeFetches, []);
	assert.equal(output.calls.length, 1);
	assert.ok(headerValues(output.calls[0]).some((header) => /^accept: text\/markdown/i.test(header)));
	assert.equal(output.result.error, null);
	assert.match(output.result.content, /Readable text fetched through the configured curl command/);
});

test("a configured fetchContent.userAgent is still sent through fetchContent.curl", async () => {
	const output = await runExtract({ fetchContent: { curl: curlCommand, userAgent: "Custom Agent/1.0" } }, { options: { mode: "raw" } });
	assert.ok(headerValues(output.calls[0]).some((header) => /^user-agent: Custom Agent\/1\.0$/i.test(header)), JSON.stringify(output.calls[0]));
});

test("redirects through fetchContent.curl are followed and checked one hop at a time", async () => {
	// --no-location after the command's own arguments overrides a configured -L, since curl uses the last one.
	const followed = await runExtract({ fetchContent: { curl: [...curlCommand, "-L"] } }, {
		options: { mode: "raw" },
		routes: {
			"https://example.com/article": { status: 301, headers: { location: "/moved" } },
			"https://example.com/moved": textRoute,
		},
	});
	assert.deepEqual(followed.calls.map((args) => args.at(-1)), ["https://example.com/article", "https://example.com/moved"]);
	for (const args of followed.calls) assert.ok(args.indexOf("--no-location") > args.indexOf("-L"), JSON.stringify(args));
	assert.equal(followed.result.content, "curl body");

	const blocked = await runExtract({ fetchContent: { curl: curlCommand } }, {
		routes: { "https://example.com/article": { status: 302, headers: { location: "http://127.0.0.1/admin" } } },
	});
	assert.equal(blocked.calls.length, 1);
	assert.match(blocked.result.error, /^Blocked internal address for 127\.0\.0\.1/);
});

test("fetchContent.curl uses the configured proxy, and an empty per-call proxy connects directly", async () => {
	const config = { proxy: "http://proxy.test:8080", fetchContent: { curl: curlCommand } };
	const proxied = await runExtract(config, { options: { mode: "raw" }, configuredProxyScope: true });
	const args = proxied.calls[0];
	assert.equal(args[args.indexOf("-x") + 1], "http://proxy.test:8080/");
	assert.deepEqual(proxied.nodeFetches, []);

	const direct = await runExtract(config, { options: { mode: "raw", proxy: "" }, configuredProxyScope: true });
	assert.equal(direct.calls[0][direct.calls[0].indexOf("-x") + 1], "", JSON.stringify(direct.calls[0]));
});

test("a curl download that fails partway is an error, not a short page", async () => {
	const output = await runExtract({ fetchContent: { curl: curlCommand } }, {
		options: { mode: "raw" },
		routes: { "https://example.com/article": { ...textRoute, body: "partial", exitCode: 18, stderr: "curl: (18) transfer closed with outstanding read data remaining" } },
	});
	assert.match(output.result.error, /exited with code 18: curl: \(18\) transfer closed/);
	assert.equal(output.result.content, "");
});

test("fetchContent.curl sends [ ] { } in a URL literally instead of letting curl expand them", async () => {
	const url = "https://example.com/search?ids[]=1&x={a,b}";
	const output = await runExtract({ fetchContent: { curl: curlCommand } }, { url, options: { mode: "raw" } });
	assert.equal(output.calls.length, 1);
	assert.ok(output.calls[0].includes("--globoff"), JSON.stringify(output.calls[0]));
	assert.equal(output.calls[0].at(-1), url);
});

test("with ssrf.trustEnvProxy, fetchContent.curl goes through the env proxy that skipped the DNS check", async () => {
	const output = await runExtract({ ssrf: { trustEnvProxy: true }, fetchContent: { curl: curlCommand } }, {
		url: "http://example.com/article",
		options: { mode: "raw" },
		env: { HTTP_PROXY: "http://proxy.corp:3128", NO_PROXY: "" },
	});
	const args = output.calls[0];
	assert.equal(args[args.indexOf("-x") + 1], "http://proxy.corp:3128", JSON.stringify(args));
	assert.equal(args[args.indexOf("--noproxy") + 1], "", JSON.stringify(args));
	assert.equal(output.result.content, "curl body");

	// An IP literal is checked locally, so it still connects directly.
	const literal = await runExtract({ ssrf: { trustEnvProxy: true }, fetchContent: { curl: curlCommand } }, {
		url: "http://93.184.216.34/article",
		options: { mode: "raw" },
		env: { HTTP_PROXY: "http://proxy.corp:3128", NO_PROXY: "" },
	});
	assert.equal(literal.calls[0][literal.calls[0].indexOf("-x") + 1], "", JSON.stringify(literal.calls[0]));
});

test("curl stops a download over the size limit and the fetch fails as too large", async () => {
	const output = await runExtract({ fetchContent: { curl: curlCommand } }, {
		options: { mode: "raw" },
		routes: { "https://example.com/article": { ...textRoute, exitCode: 63, stderr: "curl: (63) Maximum file size exceeded" } },
	});
	const args = output.calls[0];
	assert.equal(args[args.indexOf("--max-filesize") + 1], String(20 * 1024 * 1024), JSON.stringify(args));
	assert.match(output.result.error, /^Response too large/);

	// curl rejects a fractional byte count, so a fractional pdf.maxSizeMB must still fetch.
	const fractional = await runExtract({ pdf: { maxSizeMB: 7.3 }, fetchContent: { curl: curlCommand } }, { options: { mode: "raw" } });
	const fractionalArgs = fractional.calls[0];
	assert.match(fractionalArgs[fractionalArgs.indexOf("--max-filesize") + 1], /^\d+$/, JSON.stringify(fractionalArgs));
	assert.equal(fractional.result.content, "curl body");
});

test("a missing fetchContent.curl command fails the fetch by name without falling back", async () => {
	const output = await runExtract({
		fetchContent: { curl: join(fakeCurlDir, "missing-curl") },
		fetchRouting: { providers: ["http", "jina"], allowRemoteHostedProviders: true },
	});
	assert.deepEqual(output.nodeFetches, []);
	assert.match(output.result.error, /^fetchContent\.curl command not found: .*missing-curl$/);
});

test("an invalid fetchContent.curl fails before the direct fetch or any fallback provider", async () => {
	for (const curl of ["", "  ", [], [""], ["curl", " "], ["curl", 1], 42, true, { command: "curl" }, "cu\u0000rl"]) {
		const output = await runExtract({ fetchContent: { curl }, fetchRouting: { allowRemoteHostedProviders: true } });
		assert.deepEqual(output.nodeFetches, [], JSON.stringify(curl));
		assert.deepEqual(output.calls, [], JSON.stringify(curl));
		assert.match(output.result.error, /^fetchContent\.curl in .*web-search\.json must be a command name or path, or a non-empty array of a command and its arguments$/);
	}
});
