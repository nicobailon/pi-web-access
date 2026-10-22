import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const providers = [
	{ name: "Parallel", id: "parallel", env: "PARALLEL_BASE_URL", credential: "parallelApiKey", header: "x-api-key", paths: ["/v1/search", "/v1/extract"] },
	{ name: "Serper", id: "serper", env: "SERPER_BASE_URL", credential: "serperApiKey", header: "X-API-KEY", paths: ["/search"] },
	{ name: "SerpApi", id: "serpapi", env: "SERPAPI_BASE_URL", credential: "serpapiApiKey", header: null, paths: ["/search.json"] },
	{ name: "Brave", id: "brave", env: "BRAVE_BASE_URL", credential: "braveApiKey", header: "X-Subscription-Token", paths: ["/web/search"] },
	{ name: "Exa", id: "exa", env: "EXA_BASE_URL", credential: "exaApiKey", header: "x-api-key", paths: ["/search"] },
	{ name: "Tavily", id: "tavily", env: "TAVILY_BASE_URL", credential: "tavilyApiKey", header: "Authorization", headerPrefix: "Bearer ", paths: ["/search"] },
];
const key = "gateway-test-key";
const response = {
	results: [{ title: "Result", url: "https://example.com/page", excerpts: ["Content ".repeat(100)] }],
	organic: [],
	organic_results: [],
};

async function runProvider(t, provider, script, config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-base-url-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		[provider.credential]: key,
		...config,
	}));
	const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home };
	for (const item of providers) {
		delete env[item.env];
		delete env[item.env.replace(/_BASE_URL$/, "_ALLOW_HTTP")];
		delete env[({ parallel: "PARALLEL_API_KEY", serper: "SERPER_API_KEY", serpapi: "SERPAPI_KEY", brave: "BRAVE_API_KEY", exa: "EXA_API_KEY", tavily: "TAVILY_API_KEY" })[item.id]];
	}
	delete env.XDG_CONFIG_HOME;
	const moduleUrl = new URL(`../${provider.id}.ts`, import.meta.url).href;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import assert from "node:assert/strict";
			const provider = ${JSON.stringify(provider)};
			const key = ${JSON.stringify(key)};
			const credential = (provider.headerPrefix ?? "") + key;
			const response = ${JSON.stringify(response)};
			const module = await import(${JSON.stringify(moduleUrl)});
			const search = module[${JSON.stringify({ parallel: "searchWithParallel", serper: "searchWithSerper", serpapi: "searchWithSerpApi", brave: "searchWithBrave", exa: "searchWithExa", tavily: "searchWithTavily" }[provider.id])}];
			const invoke = async () => {
				await search("gateway query");
				if (provider.id === "parallel") await module.extractWithParallel("https://example.com/page");
			};
			${script}
		`,
		env,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr || child.stdout);
}

for (const provider of providers) {
	test(`${provider.name} preserves official endpoints by default`, async (t) => {
		await runProvider(t, provider, `
			const calls = [];
			globalThis.fetch = async (url, init) => {
				calls.push(new URL(url));
				return Response.json(response);
			};
			await invoke();
			assert.deepEqual(calls.map(url => url.origin + url.pathname), provider.paths.map(path =>
				({parallel: "https://api.parallel.ai", serper: "https://google.serper.dev", serpapi: "https://serpapi.com", brave: "https://api.search.brave.com/res/v1", exa: "https://api.exa.ai", tavily: "https://api.tavily.com"})[provider.id] + path));
		`);
	});

	test(`${provider.name} preserves gateway prefixes and lets the environment override config`, async (t) => {
		await runProvider(t, provider, `
			const calls = [];
			globalThis.fetch = async (url, init) => {
				const target = new URL(url);
				calls.push(target.origin + target.pathname);
				assert.equal(provider.header ? new Headers(init.headers).get(provider.header) : target.searchParams.get("api_key"), credential);
				assert.equal(init.redirect, "manual");
				return Response.json(response);
			};
			await invoke();
			process.env[provider.env] = "https://env.example.com/proxy/" + provider.id + "///";
			await invoke();
			assert.deepEqual(calls, [
				...provider.paths.map(path => "https://gateway.example.com/proxy/" + provider.id + path),
				...provider.paths.map(path => "https://env.example.com/proxy/" + provider.id + path),
			]);
		`, { [provider.id + "BaseUrl"]: `https://gateway.example.com/proxy/${provider.id}///` });
	});

	test(`${provider.name} rejects invalid overrides before fetching and accepts loopback HTTP`, async (t) => {
		await runProvider(t, provider, `
			const calls = [];
			globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json(response); };
			for (const value of ["", "not-a-url", "http://gateway.example.com", "http://localhost.example", "https://user:secret@gateway.example.com", "https://gateway.example.com?debug=true", "https://gateway.example.com#fragment"]) {
				process.env[provider.env] = value;
				await assert.rejects(invoke, new RegExp(provider.env));
			}
			delete process.env[provider.env];
			await assert.rejects(invoke, new RegExp(provider.id + "BaseUrl"));
			assert.equal(calls.length, 0);
			for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
				process.env[provider.env] = "http://" + host + ":8080/proxy/";
				await invoke();
			}
			assert.equal(calls.length, provider.paths.length * 3);
			assert.ok(calls.every(url => url.startsWith("http://")));
		`, { [provider.id + "BaseUrl"]: "https://user:secret@gateway.example.com" });
	});

	test(`${provider.name} HTTP opt-in covers config and environment gateways without relaxing URL validation`, async (t) => {
		await runProvider(t, provider, `
			const calls = [];
			globalThis.fetch = async (url, init) => {
				const target = new URL(url);
				calls.push(target.origin + target.pathname);
				assert.equal(provider.header ? new Headers(init.headers).get(provider.header) : target.searchParams.get("api_key"), credential);
				return Response.json(response);
			};
			await invoke();
			process.env[provider.env] = "http://env.example.com:8080/proxy/" + provider.id + "///";
			await invoke();
			assert.deepEqual(calls, [
				...provider.paths.map(path => "http://client-gateway:8080/proxy/" + provider.id + path),
				...provider.paths.map(path => "http://env.example.com:8080/proxy/" + provider.id + path),
			]);
			for (const value of ["", "not-a-url", "ftp://gateway.example.com", "http://user:secret@gateway.example.com", "http://gateway.example.com?debug=true", "http://gateway.example.com#fragment"]) {
				process.env[provider.env] = value;
				await assert.rejects(invoke, new RegExp(provider.env));
			}
			assert.equal(calls.length, provider.paths.length * 2);
		`, { [provider.id + "BaseUrl"]: `http://client-gateway:8080/proxy/${provider.id}///`, [provider.id + "AllowHttp"]: true });
	});

	test(`${provider.name} HTTP environment flag overrides JSON and is re-read for every operation`, async (t) => {
		await runProvider(t, provider, `
			const allowHttpEnv = provider.env.replace(/_BASE_URL$/, "_ALLOW_HTTP");
			const calls = [];
			globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json(response); };
			for (const value of ["true", "1"]) {
				process.env[allowHttpEnv] = value;
				await invoke();
			}
			for (const value of ["false", "0"]) {
				process.env[allowHttpEnv] = value;
				await assert.rejects(invoke, /must be an absolute HTTPS URL/);
			}
			for (const value of ["", "yes"]) {
				process.env[allowHttpEnv] = value;
				await assert.rejects(invoke, new RegExp(allowHttpEnv + " must be true, false, 1, or 0"));
			}
			delete process.env[allowHttpEnv];
			await invoke();
			assert.equal(calls.length, provider.paths.length * 3);
			assert.ok(calls.every(url => url.startsWith("http://client-gateway:8080/proxy/")));
		`, { [provider.id + "BaseUrl"]: `http://client-gateway:8080/proxy/${provider.id}`, [provider.id + "AllowHttp"]: true });
	});

	test(`${provider.name} honors false and rejects non-boolean HTTP opt-ins before fetching`, async (t) => {
		for (const allowHttp of [false, "true"]) {
			await runProvider(t, provider, `
				let calls = 0;
				globalThis.fetch = async () => { calls++; return Response.json(response); };
				await assert.rejects(invoke, new RegExp(provider.id + ${JSON.stringify(allowHttp === false
					? "BaseUrl .* must be an absolute HTTPS URL"
					: "AllowHttp .* must be a boolean")}));
				assert.equal(calls, 0);
			`, { [provider.id + "BaseUrl"]: "http://gateway.example.com", [provider.id + "AllowHttp"]: allowHttp });
		}
	});

	test(`${provider.name} enforces HTTP opt-ins for HTTPS downgrade redirects`, async (t) => {
		for (const configuredAllowHttp of [false, true]) {
			await runProvider(t, provider, `
				const allowHttpEnv = provider.env.replace(/_BASE_URL$/, "_ALLOW_HTTP");
				const calls = [];
				globalThis.fetch = async (url, init) => {
					const target = new URL(url);
					calls.push({url: target.href, body: init.body, credential: provider.header ? new Headers(init.headers).get(provider.header) : target.searchParams.get("api_key")});
					if (target.protocol === "https:") return new Response(null, {status: 307, headers: {location: "http://redirect.example.com/collect"}});
					return Response.json(response);
				};
				for (const value of [undefined, "0", "1"]) {
					if (value === undefined) delete process.env[allowHttpEnv];
					else process.env[allowHttpEnv] = value;
					calls.length = 0;
					const allowed = value === undefined ? ${configuredAllowHttp} : value === "1";
					if (allowed) {
						await invoke();
						assert.equal(calls.length, provider.paths.length * 2);
						for (let i = 0; i < calls.length; i += 2) {
							assert.equal(calls[i + 1].credential, null);
							assert.equal(calls[i + 1].body, calls[i].body);
						}
					} else {
						await assert.rejects(invoke, /HTTP API requests require/);
						assert.equal(calls.length, 1);
						if (provider.id === "parallel") {
							calls.length = 0;
							await assert.rejects(() => module.extractWithParallel("https://example.com/page"), /HTTP API requests require/);
							assert.equal(calls.length, 1);
						}
					}
				}
			`, { [provider.id + "BaseUrl"]: "https://gateway.example.com/api", [provider.id + "AllowHttp"]: configuredAllowHttp });
		}
	});

	test(`${provider.name} retains same-origin credentials and strips them on cross-origin redirects`, async (t) => {
		await runProvider(t, provider, `
			const calls = [];
			globalThis.fetch = async (url, init) => {
				const target = new URL(url);
				calls.push({
					target: target.href,
					credential: provider.header ? new Headers(init.headers).get(provider.header) : target.searchParams.get("api_key"),
					method: init.method ?? "GET",
					body: init.body,
					signal: init.signal,
				});
				const hop = (calls.length - 1) % 3;
				if (hop === 0) return new Response(null, {status: 307, headers: {location: target.pathname + target.search}});
				if (hop === 1) {
					target.hostname = "other.example.com";
					if (!provider.header) target.searchParams.append("api_key", key);
					target.searchParams.set("keep", "yes");
					return new Response(null, {status: 307, headers: {location: target.href}});
				}
				assert.equal(target.searchParams.get("keep"), "yes");
				return Response.json(response);
			};
			await invoke();
			for (let i = 0; i < calls.length; i += 3) {
				assert.deepEqual(calls.slice(i, i + 3).map(call => call.credential), [credential, credential, null]);
				assert.equal(calls[i + 2].method, calls[i].method);
				assert.equal(calls[i + 2].body, calls[i].body);
				assert.equal(calls[i + 2].signal, calls[i].signal);
				if (!provider.header) assert.deepEqual(new URL(calls[i + 2].target).searchParams.getAll("api_key"), []);
			}
		`, { [provider.id + "BaseUrl"]: `https://gateway.example.com/${provider.id}` });
	});
}

test("one provider's HTTP opt-in does not enable HTTP for other providers", async (t) => {
	const provider = providers.find(provider => provider.id === "brave");
	for (const fromEnvironment of [false, true]) {
		await runProvider(t, provider, `
			if (${fromEnvironment}) process.env.BRAVE_ALLOW_HTTP = "true";
			let calls = 0;
			globalThis.fetch = async () => { calls++; return Response.json(response); };
			await invoke();
			const { searchWithExa } = await import(${JSON.stringify(new URL("../exa.ts", import.meta.url).href)});
			const { searchWithTavily } = await import(${JSON.stringify(new URL("../tavily.ts", import.meta.url).href)});
			await assert.rejects(() => searchWithExa("gateway query"), /exaBaseUrl .* must be an absolute HTTPS URL/);
			await assert.rejects(() => searchWithTavily("gateway query"), /tavilyBaseUrl .* must be an absolute HTTPS URL/);
			assert.equal(calls, 1);
		`, {
			braveBaseUrl: "http://gateway.example.com/brave",
			braveAllowHttp: !fromEnvironment,
			exaApiKey: key,
			exaBaseUrl: "http://gateway.example.com/exa",
			tavilyApiKey: key,
			tavilyBaseUrl: "http://gateway.example.com/tavily",
			tavilyAllowHttp: false,
		});
	}
});

test("SerpApi redirect-limit errors omit query credentials", async (t) => {
	await runProvider(t, providers[2], `
		let calls = 0;
		globalThis.fetch = async (url) => {
			calls++;
			return new Response(null, {status: 307, headers: {location: String(url)}});
		};
		await assert.rejects(invoke, error => {
			assert.match(error.message, /Too many API redirects/);
			assert.ok(!error.message.includes(key));
			assert.ok(!error.message.includes("api_key"));
			return true;
		});
		assert.equal(calls, 6);
	`);
});
