import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import { createStandaloneWebToolCore } from "../web-tool-core.ts";
import { createCurlFetch, getActiveProxy, installGlobalProxyFetch, isProxyBypassedUrl, normalizeProxyUrl, runWithProxy } from "../utils.ts";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const originalNoProxy = process.env.NO_PROXY;
const originalNoProxyLower = process.env.no_proxy;
const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const ssrfProtectionUrl = new URL("../ssrf-protection.ts", import.meta.url).href;
const indexUrl = new URL("../index.ts", import.meta.url).href;

function runConfigProbe(dir, script) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { getActiveProxy, hasScopedProxyDecision, runWithProxy } = await import(${JSON.stringify(utilsUrl)});
			const { validateRemoteUrl } = await import(${JSON.stringify(ssrfProtectionUrl)});
			${script}
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: dir },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

async function withFakeCurl(t, routes, fn) {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-test-"));
	const logPath = join(dir, "curl-args.jsonl");
	const curlPath = join(dir, "curl");
	await writeFile(curlPath, `#!/usr/bin/env node
const fs = require("node:fs");
const routes = JSON.parse(process.env.PI_PROXY_TEST_ROUTES);
const args = process.argv.slice(2);
// Header files are deleted after curl exits, so record what they held.
const headers = args.flatMap((arg, index) => args[index - 1] !== "-H" ? [] : arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8").split("\\n").filter(Boolean) : [arg]);
const proxy = args.includes("-K") ? JSON.parse(fs.readFileSync(args[args.indexOf("-K") + 1], "utf8").match(/^proxy = (".*")$/m)[1]) : null;
fs.appendFileSync(process.env.PI_PROXY_TEST_LOG, JSON.stringify({ args, headers, proxy }) + "\\n");
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}
const url = args[args.length - 1];
const route = routes[url];
if (!route) throw new Error("unexpected url " + url);
fs.writeFileSync(valueAfter("-D"), "HTTP/1.1 " + route.status + " " + route.statusText + "\\r\\n" + (route.location ? "Location: " + route.location + "\\r\\n" : "") + "\\r\\n");
fs.writeFileSync(valueAfter("--output"), route.body || "");
process.stdout.write(JSON.stringify({ url_effective: url, num_redirects: 0 }));
`);
	await chmod(curlPath, 0o755);
	process.env.PATH = `${dir}:${originalPath ?? ""}`;
	process.env.PI_PROXY_TEST_LOG = logPath;
	process.env.PI_PROXY_TEST_ROUTES = JSON.stringify(routes);
	process.env.NO_PROXY = "";
	process.env.no_proxy = "";
	globalThis.fetch = originalFetch;
	installGlobalProxyFetch();
	t.after(async () => {
		globalThis.fetch = originalFetch;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = originalNoProxy;
		if (originalNoProxyLower === undefined) delete process.env.no_proxy;
		else process.env.no_proxy = originalNoProxyLower;
		delete process.env.PI_PROXY_TEST_LOG;
		delete process.env.PI_PROXY_TEST_ROUTES;
		await rm(dir, { recursive: true, force: true });
	});
	const result = await fn(logPath);
	return result;
}

async function readCurlCalls(logPath) {
	return (await readFile(logPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const { args, headers, proxy } = JSON.parse(line);
			return Object.assign(args, { headers, proxy });
		});
}

function headerValues(args) {
	return args.headers;
}

function registerSourceCheck() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find((tool) => tool.name === "source_check");
}

function registerFetchContent() {
	const tools = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry() {},
	});
	return tools.find((tool) => tool.name === "fetch_content");
}

function proxyArg(args) {
	return args.proxy;
}

test("proxy normalization preserves default HTTP(S) ports for curl", () => {
	for (const [input, expected] of [
		["http://proxy.example", "http://proxy.example:80/"],
		["http://proxy.example:80", "http://proxy.example:80/"],
		["https://proxy.example", "https://proxy.example:443/"],
		["https://proxy.example:443", "https://proxy.example:443/"],
		["http://proxy.example:8080", "http://proxy.example:8080/"],
		["https://proxy.example:8443", "https://proxy.example:8443/"],
		["http://user:p%40ss@proxy.example:80", "http://user:p%40ss@proxy.example:80/"],
		["https://user:p%40ss@proxy.example:443", "https://user:p%40ss@proxy.example:443/"],
		["http://[::1]:80", "http://[::1]:80/"],
		["https://[::1]:443", "https://[::1]:443/"],
		["http://proxy.example:80/path?query=1#fragment", "http://proxy.example:80/path"],
		["socks5h://proxy.example:1080", "socks5h://proxy.example:1080"],
		["socks5://proxy.example", "socks5://proxy.example"],
		["", null],
		[undefined, null],
	]) {
		assert.equal(normalizeProxyUrl(input, "test proxy"), expected, String(input));
	}
});

test("default HTTP(S) proxy ports reach curl explicitly", async (t) => {
	await withFakeCurl(t, {
		"https://example.com/page": { status: 200, statusText: "OK", body: "through proxy" },
	}, async (logPath) => {
		const cases = [
			["http://proxy.example", "http://proxy.example:80/"],
			["http://proxy.example:80", "http://proxy.example:80/"],
			["https://proxy.example", "https://proxy.example:443/"],
			["https://proxy.example:443", "https://proxy.example:443/"],
		];
		for (const [proxy] of cases) {
			const response = await runWithProxy(proxy, () => fetch("https://example.com/page"));
			assert.equal(await response.text(), "through proxy");
		}
		const calls = await readCurlCalls(logPath);
		assert.deepEqual(calls.map(proxyArg), cases.map(([, expected]) => expected));
	});
});

for (const [proxy, expected] of [
	["http://call-proxy.example", "http://call-proxy.example:80/"],
	["https://call-proxy.example", "https://call-proxy.example:443/"],
]) {
	for (const toolName of ["webSearch", "sourceCheck"]) {
		test(`${toolName} uses the default port for caller-attached ${proxy} on result pages`, async (t) => {
			const previousKey = process.env.BRAVE_API_KEY;
			process.env.BRAVE_API_KEY = "default-port-test-key";
			t.after(() => {
				if (previousKey === undefined) delete process.env.BRAVE_API_KEY;
				else process.env.BRAVE_API_KEY = previousKey;
			});
			const apiUrl = "https://api.search.brave.com/res/v1/web/search?q=proxy+ports&count=1";
			const pageUrl = "https://example.com/default-port";
			await withFakeCurl(t, {
				[apiUrl]: {
					status: 200, statusText: "OK",
					body: JSON.stringify({ web: { results: [{ title: "Proxy ports", url: pageUrl, description: "Proxy port docs" }] } }),
				},
				[pageUrl]: { status: 200, statusText: "OK", body: "<html><title>Proxy ports</title><body>Default proxy port documentation.</body></html>" },
			}, async (logPath) => {
				const core = createStandaloneWebToolCore();
				const result = await core[toolName]({
					...(toolName === "webSearch"
						? { query: "proxy ports", includeContent: true }
						: { claim: "proxy ports", fetchContent: true }),
					provider: "brave", numResults: 1, proxy,
				});
				assert.notEqual(result.isError, true, JSON.stringify(result));
				const calls = await readCurlCalls(logPath);
				assert.deepEqual(calls.map(args => args.at(-1)), [apiUrl, pageUrl]);
				assert.deepEqual(calls.map(proxyArg), [expected, expected]);
			});
		});
	}
}

test("configured default HTTP proxy port matches equivalent locked per-call URLs", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-default-port-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://proxy.example:80", lockProxy: true }));
	assert.deepEqual(runConfigProbe(dir, `
		console.log(JSON.stringify([
			runWithProxy(undefined, () => getActiveProxy()),
			runWithProxy("http://proxy.example", () => getActiveProxy()),
			runWithProxy("http://proxy.example:80", () => getActiveProxy()),
		]));
	`), Array(3).fill("http://proxy.example:80/"));
});

test("a proxy set through a second loaded copy of the module is not skipped", async (t) => {
	await withFakeCurl(t, {
		"https://example.com/page": { status: 200, statusText: "OK", body: "through proxy" },
	}, async (logPath) => {
		let directCalls = 0;
		globalThis.fetch = async () => {
			directCalls++;
			return new Response("direct");
		};
		installGlobalProxyFetch();
		const reloaded = await import(`${utilsUrl}?reloaded`);
		assert.notEqual(reloaded.runWithProxy, runWithProxy);

		const response = await reloaded.runWithProxy("http://reload-proxy.example:8080", () => fetch("https://example.com/page"));
		assert.equal(await response.text(), "through proxy");
		assert.equal(directCalls, 0);
		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 1);
		assert.ok(["http://reload-proxy.example:8080", "http://reload-proxy.example:8080/"].includes(proxyArg(calls[0])));
	});
});

test("wrapping stays bounded when an older copy of the module keeps installing its wrapper", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	let directCalls = 0;
	globalThis.fetch = async () => {
		directCalls++;
		return new Response("direct");
	};
	// Same skip rule as versions before the shared proxy store.
	const installOldWrapper = () => {
		const current = globalThis.fetch;
		if (current.__piWebAccessProxyFetch === true) return;
		const wrapped = (input, init) => current(input, init);
		wrapped.__piWebAccessProxyFetch = true;
		globalThis.fetch = wrapped;
	};
	installOldWrapper();
	installGlobalProxyFetch();
	const settled = globalThis.fetch;
	for (let round = 0; round < 5; round++) {
		installOldWrapper();
		installGlobalProxyFetch();
	}
	assert.equal(globalThis.fetch, settled);
	assert.equal(await (await fetch("https://example.com/page")).text(), "direct");
	assert.equal(directCalls, 1);
});

test("extension initialization preserves fetch identity and installs proxy transport on first proxied tool call", async (t) => {
	await withFakeCurl(t, {
		"https://example.com/page": {
			status: 200,
			statusText: "OK",
			body: "<html><title>Proxy page</title><body>Fetched lazily through the requested proxy.</body></html>",
		},
	}, async (logPath) => {
		const configDir = dirname(logPath);
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const hostFetch = globalThis.fetch;
				const tools = [];
				const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
				initializeExtension({
					registerTool(tool) { tools.push(tool); },
					registerCommand() {},
					registerShortcut() {},
					on() {},
					appendEntry() {},
				});
				const unchangedAfterInit = globalThis.fetch === hostFetch;
				const tool = tools.find((candidate) => candidate.name === "fetch_content");
				const result = await tool.execute("call", {
					url: "https://example.com/page",
					proxy: "http://call-proxy.example:8080",
				});
				console.log(JSON.stringify({
					unchangedAfterInit,
					installedAfterProxyCall: globalThis.fetch !== hostFetch,
					successful: result.details.successful,
				}));
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
			maxBuffer: 2 * 1024 * 1024,
		});

		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), {
			unchangedAfterInit: true,
			installedAfterProxyCall: true,
			successful: 1,
		});
		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].at(-1), "https://example.com/page");
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(calls[0])));
	});
});

test("proxy curl gets request headers and the proxy URL from files, never its command line", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/private": { status: 200, statusText: "OK", body: "ok" },
	}, async (logPath) => {
		const response = await runWithProxy("http://user:proxy-secret@proxy.example:8080", () => fetch("https://origin.example/private", {
			headers: { Cookie: "session=cookie-secret", Authorization: "Bearer token-secret" },
		}));

		assert.equal(await response.text(), "ok");
		const [args] = await readCurlCalls(logPath);
		assert.ok(args.every((arg) => !/cookie-secret|token-secret|proxy-secret/.test(arg)), JSON.stringify(args));
		assert.equal(args.proxy, "http://user:proxy-secret@proxy.example:8080/");
		assert.ok(args.headers.includes("cookie: session=cookie-secret"), JSON.stringify(args.headers));
		assert.ok(args.headers.includes("authorization: Bearer token-secret"), JSON.stringify(args.headers));
	});
});

test("proxy curl redirects strip caller headers across origins", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "https://other.example/final" },
		"https://other.example/final": { status: 200, statusText: "OK", body: "ok" },
	}, async (logPath) => {
		const response = await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", {
			headers: {
				Authorization: "Bearer secret",
				Cookie: "session=secret",
				"X-Api-Key": "secret",
				Accept: "text/html",
			},
		}));

		assert.equal(await response.text(), "ok");
		assert.equal(response.url, "https://other.example/final");
		assert.equal(response.redirected, true);
		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 2);
		assert.ok(headerValues(calls[0]).some((header) => /^authorization:/i.test(header)));
		assert.deepEqual(headerValues(calls[1]), []);
		assert.ok(calls.every((args) => !args.includes("--location")));
	});
});

test("configured proxy is scoped to web operations while empty string forces direct access", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-config-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://global-proxy.example:8080" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.deepEqual(runConfigProbe(dir, `
		console.log(JSON.stringify([
			getActiveProxy(),
			runWithProxy(undefined, () => getActiveProxy()),
			runWithProxy("", () => getActiveProxy()),
			runWithProxy("http://call-proxy.example:8080", () => getActiveProxy()),
			getActiveProxy(),
		]));
	`), [
		null,
		"http://global-proxy.example:8080/",
		null,
		"http://call-proxy.example:8080/",
		null,
	]);
});

test("omitted proxy preserves trusted environment proxy routing when no proxy is configured", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-env-trust-test-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.deepEqual(runConfigProbe(dir, `
		for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
			delete process.env[key];
		}
		process.env.HTTPS_PROXY = "http://env-proxy.example:8080";
		let lookups = 0;
		await runWithProxy(undefined, () => validateRemoteUrl("https://public.example.test/", {
			trustEnvProxy: true,
			lookup: async () => {
				lookups++;
				return [{ address: "10.0.0.10", family: 4 }];
			},
		}));
		console.log(JSON.stringify({ lookups, scoped: hasScopedProxyDecision() }));
	`), { lookups: 0, scoped: false });
});

test("fetch_content lets a trusted configured proxy resolve hostnames that local DNS cannot", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-trusted-dns-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://configured-proxy.example:3128", ssrf: { trustEnvProxy: true } }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	// `.test` never resolves, so success proves no local DNS preflight ran.
	const url = "https://unresolvable.example.test/page";

	await withFakeCurl(t, {
		[url]: { status: 200, statusText: "OK", body: "<html><title>Proxied</title><body>Resolved by the proxy.</body></html>" },
	}, async (logPath) => {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
				const tools = [];
				initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
				const tool = tools.find((tool) => tool.name === "fetch_content");
				const omitted = await tool.execute("omitted", { url: ${JSON.stringify(url)} });
				const explicit = await tool.execute("explicit", { url: ${JSON.stringify(url)}, proxy: "http://configured-proxy.example:3128" });
				console.log(JSON.stringify([omitted.details.successful, explicit.details.successful]));
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: dir },
			maxBuffer: 2 * 1024 * 1024,
		});
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1)), [1, 1]);
		const pageCalls = (await readCurlCalls(logPath)).filter((args) => args.at(-1) === url);
		assert.equal(pageCalls.length, 2);
		assert.ok(pageCalls.every((args) => ["http://configured-proxy.example:3128", "http://configured-proxy.example:3128/"].includes(proxyArg(args))));
	});
});

test("configured proxy DNS trust never extends to a different per-call proxy", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-trust-scope-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://configured-proxy.example:3128" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const probe = (trustEnvProxy) => `
		const privateLookup = async () => [{ address: "10.0.0.10", family: 4 }];
		const outcome = async (fn) => { try { await fn(); return "trusted"; } catch (error) { return error.message; } };
		const validate = (options = {}) => validateRemoteUrl("https://internal.example.test/", { trustEnvProxy: ${trustEnvProxy}, lookup: privateLookup, ...options });
		console.log(JSON.stringify([
			await runWithProxy(undefined, () => outcome(() => validate())),
			await runWithProxy("http://model-proxy.example:3128", () => outcome(() => validate())),
			await runWithProxy(undefined, () => outcome(() => validate({ proxy: "http://model-proxy.example:3128" }))),
			await runWithProxy(undefined, () => outcome(() => validate({ lookup: async () => { throw new Error("getaddrinfo ENOTFOUND"); } }))),
		]));
	`;

	const [trusted, perCall, pinned] = runConfigProbe(dir, probe(true));
	assert.equal(trusted, "trusted");
	assert.match(perCall, /Blocked internal address/);
	assert.match(pinned, /Blocked internal address/);

	const untrusted = runConfigProbe(dir, probe(false));
	assert.match(untrusted[0], /Blocked internal address/);
	assert.match(untrusted[3], /^Failed to resolve internal\.example\.test: getaddrinfo ENOTFOUND\. If your configured proxy resolves hostnames, set ssrf\.trustEnvProxy to true/);
});

test("lockProxy rejects per-call proxy overrides before any request runs", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-lock-test-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const probe = `
		let calls = 0;
		const outcome = (proxy) => { try { return runWithProxy(proxy, () => { calls++; return getActiveProxy(); }); } catch (error) { return error.message; } };
		console.log(JSON.stringify({ results: [outcome(undefined), outcome("http://credential-proxy.example:8080"), outcome(""), outcome("http://other-proxy.example:8080")], calls }));
	`;

	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://credential-proxy.example:8080", lockProxy: true }));
	const locked = runConfigProbe(dir, probe);
	assert.deepEqual(locked.results.slice(0, 2), ["http://credential-proxy.example:8080/", "http://credential-proxy.example:8080/"]);
	for (const message of locked.results.slice(2)) assert.match(message, /^proxy argument rejected: lockProxy is set in .*; omit proxy to use the configured proxy$/);
	assert.equal(locked.calls, 2);

	await writeFile(join(dir, "web-search.json"), JSON.stringify({ lockProxy: true }));
	const unconfigured = runConfigProbe(dir, probe);
	for (const message of unconfigured.results) assert.match(message, /lockProxy is set in .* but no proxy is configured there/);
	assert.equal(unconfigured.calls, 0);

	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "http://credential-proxy.example:8080", lockProxy: "yes" }));
	assert.match(runConfigProbe(dir, probe).results[0], /lockProxy in .* must be true or false/);
});

test("invalid configured proxy fails closed instead of direct fetching", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-invalid-config-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "ftp://proxy.example:21" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	assert.match(runConfigProbe(dir, `
		let message = "";
		try {
			runWithProxy(undefined, () => getActiveProxy());
		} catch (error) {
			message = error.message;
		}
		console.log(JSON.stringify(message));
	`), /proxy.*must use the http:\/\/, https:\/\/, or socks scheme/);
});

test("invalid configured proxy reaches background fetch rejection handling", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-background-config-test-"));
	const configPath = join(dir, "web-search.json");
	await writeFile(configPath, JSON.stringify({ provider: "openai" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { writeFileSync } = await import("node:fs");
			const configPath = ${JSON.stringify(configPath)};
			const messages = [];
			globalThis.fetch = async (url) => {
				if (String(url) !== "https://api.openai.com/v1/responses") {
					throw new Error("Unexpected fetch: " + url);
				}
				writeFileSync(configPath, JSON.stringify({ provider: "openai", proxy: "ftp://proxy.example:21" }));
				return new Response(JSON.stringify({ output: [
					{ type: "web_search_call", action: { sources: [{ title: "Source", url: "https://example.com/source" }] } },
					{ type: "message", content: [{ type: "output_text", text: "Search answer" }] },
				] }), { status: 200, headers: { "content-type": "application/json" } });
			};
			const tools = [];
			const handlers = new Map();
			const pi = {
				registerTool(tool) { tools.push(tool); },
				registerCommand() {},
				registerShortcut() {},
				on(event, handler) { handlers.set(event, handler); },
				appendEntry() {},
				sendMessage(message) { messages.push(message); },
			};
			const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
			initializeExtension(pi);
			await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
			const tool = tools.find((candidate) => candidate.name === "web_search");
			const result = await tool.execute("background-proxy-test", {
				query: "proxy cleanup",
				provider: "openai",
				workflow: "none",
				includeContent: true,
			});
			await new Promise((resolve) => setImmediate(resolve));
			console.log(JSON.stringify({
				result: result.content[0].text,
				errors: messages.filter((message) => message.customType === "web-search-error").map((message) => message.content),
			}));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "proxy-background-test-key" },
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.result, /Content fetching in background/);
	assert.equal(output.errors.length, 1, JSON.stringify(output));
	assert.match(output.errors[0], /proxy.*must use the http:\/\/, https:\/\/, or socks scheme/);
});

test("proxy transport does not spawn curl for pre-aborted requests", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/abort": { status: 200, statusText: "OK", body: "late" },
	}, async (logPath) => {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/abort", { signal: controller.signal })),
			/error.*abort/i,
		);
		await assert.rejects(readFile(logPath, "utf8"), /ENOENT/);
	});
});

test("proxy transport errors redact proxy credentials", async (t) => {
	await withFakeCurl(t, {}, async () => {
		await assert.rejects(
			runWithProxy("http://user:secret@proxy.example:8080", () => fetch("https://origin.example/missing")),
			(error) => {
				assert.match(error.message, /http:\/\/redacted:redacted@proxy\.example:8080\//);
				assert.doesNotMatch(error.message, /user:secret/);
				return true;
			},
		);
	});
});

test("proxy curl redirects keep caller headers on the same origin", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "/final" },
		"https://origin.example/final": { status: 200, statusText: "OK", body: "ok" },
	}, async (logPath) => {
		await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", {
			headers: { Authorization: "Bearer secret" },
		}));

		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 2);
		assert.ok(headerValues(calls[1]).some((header) => /^authorization:/i.test(header)));
	});
});

test("proxy curl keeps manual redirects as redirect responses", async (t) => {
	await withFakeCurl(t, {
		"https://origin.example/start": { status: 302, statusText: "Found", location: "https://other.example/final" },
	}, async (logPath) => {
		const response = await runWithProxy("http://proxy.example:8080", () => fetch("https://origin.example/start", { redirect: "manual" }));

		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "https://other.example/final");
		assert.equal((await readCurlCalls(logPath)).length, 1);
	});
});

test("source_check fetchContent uses the explicit proxy for result pages", async (t) => {
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "source-check-proxy-test-key";
	t.after(() => {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
	});

	await withFakeCurl(t, {
		"https://api.openai.com/v1/responses": {
			status: 200,
			statusText: "OK",
			body: JSON.stringify({
				output: [{ type: "web_search_call", action: { sources: [{ title: "API docs", url: "https://example.com/api" }] } }],
			}),
		},
		"https://example.com/api": { status: 200, statusText: "OK", body: "<html><title>API docs</title><body>The API docs are available.</body></html>" },
	}, async (logPath) => {
		const tool = registerSourceCheck();
		assert.ok(tool);
		const response = await tool.execute("call", {
			claim: "API docs",
			provider: "openai",
			fetchContent: true,
			proxy: "http://call-proxy.example:8080",
		}, undefined, undefined, { modelRegistry: {} });

		assert.equal(response.details.sourceCount, 1);
		const calls = await readCurlCalls(logPath);
		const apiCall = calls.find((args) => args.at(-1) === "https://api.openai.com/v1/responses");
		const pageCall = calls.find((args) => args.at(-1) === "https://example.com/api");
		assert.ok(apiCall);
		assert.ok(pageCall);
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(apiCall)));
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(pageCall)));
	});
});

test("fetch_content passes the explicit proxy through queued extraction", async (t) => {
	await withFakeCurl(t, {
		"https://example.com/page": {
			status: 200,
			statusText: "OK",
			body: "<html><title>Proxy page</title><body>Fetched through the requested proxy.</body></html>",
		},
	}, async (logPath) => {
		const tool = registerFetchContent();
		assert.ok(tool);
		const response = await tool.execute("call", {
			url: "https://example.com/page",
			proxy: "http://call-proxy.example:8080",
		});

		assert.equal(response.details.successful, 1);
		const pageCall = (await readCurlCalls(logPath)).find((args) => args.at(-1) === "https://example.com/page");
		assert.ok(pageCall);
		assert.ok(["http://call-proxy.example:8080", "http://call-proxy.example:8080/"].includes(proxyArg(pageCall)));
	});
});

test("websearch command scopes searches but not model callbacks to configured proxy", async (t) => {
	await withFakeCurl(t, {
		"https://search.example.com/serp": {
			status: 200,
			statusText: "OK",
			body: JSON.stringify({
				organic_results: [{ title: "Result", link: "https://example.com/result", snippet: "Answer" }],
			}),
		},
	}, async (logPath) => {
		const configDir = dirname(logPath);
		await writeFile(join(configDir, "web-search.json"), JSON.stringify({
			provider: "stub",
			customSearchProviders: {
				stub: { url: "https://search.example.com/serp", method: "POST", body: { q: "{query}" }, results: "organic_results", fields: { title: "title", url: "link", snippet: "snippet" } },
			},
			proxy: "http://configured-proxy.example:8080",
			autoOpenBrowser: false,
			curatorTimeoutSeconds: 5,
		}) + "\n", "utf8");

		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const { setTimeout: delay } = await import("node:timers/promises");
				const { hasScopedProxyDecision } = await import(${JSON.stringify(utilsUrl)});
				const commands = new Map();
				const notifications = [];
				const modelScoped = [];
				const model = { provider: "openai", id: "gpt-5-mini" };
				const modelRegistry = {
					getAvailable() { return [model]; },
					find(provider, id) { return provider === model.provider && id === model.id ? model : undefined; },
					async getApiKeyAndHeaders() { return { ok: true, apiKey: "summary-test-key" }; },
					async complete(_model, request, options) {
						modelScoped.push(hasScopedProxyDecision());
						if (options.signal?.aborted) throw new Error("summary signal aborted");
						const prompt = String(request.messages?.[0]?.content?.[0]?.text ?? "");
						return {
							stopReason: "stop",
							content: [{ type: "text", text: prompt.includes("Rewrite this") ? "rewritten query" : "summarized results" }],
						};
					},
				};
				const pi = {
					registerTool() {},
					registerCommand(name, command) { commands.set(name, command); },
					registerShortcut() {},
					on() {},
					appendEntry() {},
					sendMessage() {},
				};
				const initializeExtension = (await import(${JSON.stringify(indexUrl)})).default;
				initializeExtension(pi);
				const ctx = {
					model: undefined,
					modelRegistry,
					cwd: process.cwd(),
					isProjectTrusted() { return true; },
					scopedModels: [],
					ui: { notify(message, level) { notifications.push({ message, level }); } },
				};
				await commands.get("websearch").handler("initial command query", ctx);
				const urlText = notifications
					.map(note => note.message.match(/http:\\/\\/[^ ]+/)?.[0])
					.find(Boolean);
				if (!urlText) throw new Error("websearch command did not report a curator URL");
				const curatorUrl = new URL(urlText);
				const token = curatorUrl.searchParams.get("session");
				async function request(path, body) {
					const url = new URL(path, curatorUrl.origin);
					if (!body) url.searchParams.set("session", token);
					const response = await fetch(url, body ? {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ token, ...body }),
					} : undefined);
					return { status: response.status, body: await response.json() };
				}
				let state;
				for (let attempt = 0; attempt < 100; attempt++) {
					state = (await request("/state")).body;
					if (state.done) break;
					await delay(10);
				}
				if (!state?.done) throw new Error("initial websearch command did not finish");
				const added = await request("/search", { query: "added command query" });
				if (added.status !== 200 || added.body.error) throw new Error("command add-search failed");
				const rewritten = await request("/rewrite", { query: "rewrite this query" });
				if (rewritten.status !== 200 || rewritten.body.query !== "rewritten query") throw new Error("command rewrite failed");
				const summarized = await request("/summarize", { selected: [0] });
				if (summarized.status !== 200 || summarized.body.summary !== "summarized results") throw new Error("command summarize failed");
				const submitted = await request("/submit", { selected: [0], summary: "finished" });
				console.log(JSON.stringify({
					initialDone: state.done,
					addSearchStatus: added.status,
					rewriteStatus: rewritten.status,
					summarizeStatus: summarized.status,
					submitStatus: submitted.status,
					modelScoped,
				}));
				await delay(50);
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
			maxBuffer: 2 * 1024 * 1024,
		});

		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), {
			initialDone: true,
			addSearchStatus: 200,
			rewriteStatus: 200,
			summarizeStatus: 200,
			submitStatus: 200,
			modelScoped: [false, false],
		});
		const calls = await readCurlCalls(logPath);
		assert.equal(calls.length, 2);
		assert.equal(calls.filter((args) => args.at(-1) === "https://search.example.com/serp").length, 2);
		assert.ok(calls.every((args) => ["http://configured-proxy.example:8080", "http://configured-proxy.example:8080/"].includes(proxyArg(args))));
	});
});

test("configured socks5h proxy is accepted and routed to curl", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-proxy-socks-config-test-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify({ proxy: "socks5h://proxy.example:9050" }));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	await withFakeCurl(t, {
		"https://example.com/page": { status: 200, statusText: "OK", body: "through socks proxy" },
	}, async (logPath) => {
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const { getActiveProxy, installGlobalProxyFetch, runWithProxy } = await import(${JSON.stringify(utilsUrl)});
				installGlobalProxyFetch();
				const response = await runWithProxy(undefined, () => fetch("https://example.com/page"));
				console.log(JSON.stringify({ active: runWithProxy(undefined, () => getActiveProxy()), body: await response.text() }));
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: dir },
			maxBuffer: 2 * 1024 * 1024,
		});
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());

		assert.equal(output.active, "socks5h://proxy.example:9050");
		assert.equal(output.body, "through socks proxy");

		const calls = await readCurlCalls(logPath);
		const pageCall = calls.find((args) => args.at(-1) === "https://example.com/page");
		assert.ok(pageCall);
		assert.equal(proxyArg(pageCall), "socks5h://proxy.example:9050");
	});
});

for (const scheme of ["socks4", "socks4a", "socks5", "socks5h"]) {
	test(`per-call ${scheme} proxy is routed unchanged to curl`, async (t) => {
		await withFakeCurl(t, {
			"https://example.com/page": { status: 200, statusText: "OK", body: "through socks proxy" },
		}, async (logPath) => {
			const proxy = `${scheme}://proxy.example:9050`;
			const response = await runWithProxy(proxy, () => fetch("https://example.com/page"));
			assert.equal(await response.text(), "through socks proxy");
			const calls = await readCurlCalls(logPath);
			assert.equal(calls.length, 1);
			assert.equal(proxyArg(calls[0]), proxy);
		});
	});
}

test("generic socks proxy is rejected before transport runs", async (t) => {
	await withFakeCurl(t, {}, async (logPath) => {
		let called = false;
		assert.throws(() => runWithProxy("socks://proxy.example:9050", () => {
			called = true;
			return fetch("https://example.com/page");
		}), /proxy.*must use the http:\/\/, https:\/\/, or socks scheme/);
		assert.equal(called, false);
		await assert.rejects(readFile(logPath, "utf8"), /ENOENT/);
	});
});

test("GCE metadata server hosts always bypass proxy transport", (t) => {
	const previousNoProxy = process.env.NO_PROXY;
	const previousNoProxyLower = process.env.no_proxy;
	const previousGceHost = process.env.GCE_METADATA_HOST;
	delete process.env.NO_PROXY;
	delete process.env.no_proxy;
	delete process.env.GCE_METADATA_HOST;
	t.after(() => {
		if (previousNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = previousNoProxy;
		if (previousNoProxyLower === undefined) delete process.env.no_proxy;
		else process.env.no_proxy = previousNoProxyLower;
		if (previousGceHost === undefined) delete process.env.GCE_METADATA_HOST;
		else process.env.GCE_METADATA_HOST = previousGceHost;
	});

	assert.equal(isProxyBypassedUrl(new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")), true);
	assert.equal(isProxyBypassedUrl(new URL("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token")), true);
	assert.equal(isProxyBypassedUrl(new URL("https://example.com/page")), false);

	process.env.GCE_METADATA_HOST = "metadata.test:8080";
	assert.equal(isProxyBypassedUrl(new URL("http://metadata.test:8080/computeMetadata/v1/instance/service-accounts/default/token")), true);
	assert.equal(isProxyBypassedUrl(new URL("https://example.com/page")), false);

	process.env.GCE_METADATA_HOST = "http://metadata.test:8080";
	assert.equal(isProxyBypassedUrl(new URL("http://metadata.test:8080/computeMetadata/v1/instance/service-accounts/default/token")), true);
	assert.equal(isProxyBypassedUrl(new URL("https://example.com/page")), false);
});

test("real curl reads an env proxy with quotes, backslashes and line breaks as one proxy value", {
	skip: spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0 ? false : "requires curl on PATH",
}, async (t) => {
	const requests = [];
	const proxyServer = createServer((req, res) => {
		requests.push({ url: req.url, auth: req.headers["proxy-authorization"] ?? null });
		res.end("via proxy");
	});
	await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
	t.after(() => proxyServer.close());
	const { port } = proxyServer.address();
	const fetchWith = (proxy) => createCurlFetch(["curl"], { maxBytes: 1024 * 1024, envProxy: () => proxy })("http://origin.test/page");

	const response = await fetchWith(`http://us"er:p\\ss@127.0.0.1:${port}/`);
	assert.equal(await response.text(), "via proxy");
	assert.deepEqual(requests, [{ url: "http://origin.test/page", auth: `Basic ${Buffer.from('us"er:p\\ss').toString("base64")}` }]);

	// A line break must not start another curl option in the config file: here, a second proxy line
	// that would send the request to the test proxy. Read as one value, the proxy is malformed.
	await assert.rejects(fetchWith(`http://127.0.0.1:1/\nproxy = http://127.0.0.1:${port}/`));
	assert.equal(requests.length, 1);
});
