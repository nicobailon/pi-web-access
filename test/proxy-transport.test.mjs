import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import { getActiveProxy, installGlobalProxyFetch, runWithProxy } from "../utils.ts";

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
fs.appendFileSync(process.env.PI_PROXY_TEST_LOG, JSON.stringify(args) + "\\n");
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
		.map((line) => JSON.parse(line));
}

function headerValues(args) {
	const values = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-H") values.push(args[index + 1]);
	}
	return values;
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
	const index = args.indexOf("-x");
	return index === -1 ? undefined : args[index + 1];
}

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
		"https://run.xcrawl.com/v1/serp": {
			status: 200,
			statusText: "OK",
			body: JSON.stringify({
				search_metadata: { status: "completed" },
				organic_results: [{ title: "Result", link: "https://example.com/result", snippet: "Answer" }],
			}),
		},
	}, async (logPath) => {
		const configDir = dirname(logPath);
		await writeFile(join(configDir, "web-search.json"), JSON.stringify({
			provider: "xcrawl",
			xcrawlApiKey: "xc-test-key",
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
		assert.equal(calls.filter((args) => args.at(-1) === "https://run.xcrawl.com/v1/serp").length, 2);
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
