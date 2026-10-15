import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const geminiApiModuleUrl = new URL("../gemini-api.ts", import.meta.url).href;
const geminiAdcModuleUrl = new URL("../gemini-adc.ts", import.meta.url).href;
const geminiSearchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"CLOUDFLARE_API_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"GCLOUD_PROJECT",
		"GCE_METADATA_HOST",
		"METADATA_SERVER_DETECTION",
		"BRAVE_API_KEY",
	]) {
		delete childEnv[key];
	}
	// macOS homedir() ignores HOME, so pin the ADC file explicitly so tests are hermetic.
	childEnv.METADATA_SERVER_DETECTION = "none";
	Object.assign(childEnv, env);
	for (const [key, value] of Object.entries(childEnv)) {
		if (value === undefined) delete childEnv[key];
	}
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

function writeAdc(root, extra = {}) {
	return writeFile(
		join(root, "adc.json"),
		JSON.stringify({
			client_id: "synthetic-client-id",
			client_secret: "synthetic-client-secret",
			refresh_token: "synthetic-refresh-token",
			type: "authorized_user",
			universe_domain: "googleapis.com",
			...extra,
		}) + "\n",
		"utf8",
	);
}

test("Gemini search uses Vertex AI + ADC bearer auth when geminiAuth is adc", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-"));
	await writeAdc(root);
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({
			geminiAuth: "adc",
			geminiProject: "ai-eng-sandbox",
			geminiLocation: "global",
		}) + "\n",
		"utf8",
	);

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init = {}) => {
			const request = { url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)) };
			requests.push(request);
			if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
				return new Response(JSON.stringify({ access_token: "synthetic-adc-token", expires_in: 3599 }), {
					status: 200, headers: { "content-type": "application/json" },
				});
			}
			if (String(url).includes(":generateContent")) {
				return new Response(JSON.stringify({
					candidates: [{
						content: { parts: [{ text: "Paris is the capital of France." }] },
						groundingMetadata: {
							groundingChunks: [{ web: { uri: "https://en.wikipedia.org/wiki/Paris", title: "Paris" } }],
						},
					}],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch: " + request.url);
		};
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		const result = await search("what is the capital of France?", { provider: "gemini" });
		console.log(JSON.stringify({ result, requests }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.result, "expected a search result");
	assert.equal(output.result.answer, "Paris is the capital of France.");
	assert.equal(output.result.provider, "gemini");

	const tokenRequests = output.requests.filter(r => r.url.startsWith("https://oauth2.googleapis.com/token"));
	assert.equal(tokenRequests.length, 1, "expected one ADC token exchange");
	const generateRequests = output.requests.filter(r => r.url.includes(":generateContent"));
	assert.equal(generateRequests.length, 1);

	const generateRequest = generateRequests[0];
	assert.equal(generateRequest.url, "https://aiplatform.googleapis.com/v1/projects/ai-eng-sandbox/locations/global/publishers/google/models/gemini-3.6-flash:generateContent");
	assert.equal(generateRequest.headers["authorization"], "Bearer synthetic-adc-token");
	assert.ok(!generateRequest.headers["x-goog-api-key"], "must not send an API key in ADC mode");
});

test("Gemini ADC availability requires geminiAuth adc, project, location, and an ADC file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-avail-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n", "utf8");

	// ADC file does not exist yet -> not available.
	const child = runChild(`
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({ adcAvail: adc.isGeminiAdcAvailable(), apiAvail: isGeminiApiAvailable() }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { adcAvail: false, apiAvail: false });

	// Now write an ADC file; availability should flip on.
	await writeAdc(root);
	const child2 = runChild(`
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({ adcAvail: adc.isGeminiAdcAvailable(), apiAvail: isGeminiApiAvailable(), missingProject: (await import(${JSON.stringify(geminiAdcModuleUrl)})).getAdcProject() }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(child2.status, 0, child2.stderr);
	const avail = JSON.parse(child2.stdout.trim());
	assert.equal(avail.adcAvail, true);
	assert.equal(avail.apiAvail, true);
});

test("Gemini ADC config parse errors stay visible", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-config-"));
	await writeFile(join(root, "web-search.json"), "not valid JSON", "utf8");

	const child = runChild(`
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			adc.isGeminiAdcAvailable();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Failed to parse .*web-search\.json/);
});

test("Gemini ADC credential parse errors include the file path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-file-"));
	const adcPath = join(root, "adc.json");
	await writeFile(adcPath, "not valid JSON", "utf8");

	const child = runChild(`
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: adcPath });

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Failed to parse Google Application Default Credentials file at /);
	assert.match(error, /adc\.json/);
});

test("Gemini ADC credential shape errors include the file path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-shape-"));
	const adcPath = join(root, "adc.json");
	await writeFile(adcPath, JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "secret" }) + "\n", "utf8");

	const child = runChild(`
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: adcPath });

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Failed to parse Google Application Default Credentials file at /);
	assert.match(error, /authorized_user file is missing refresh_token/);
});

test("Gemini ADC rejects malformed token success responses", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-token-shape-"));
	await writeAdc(root);
	const env = { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") };

	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ access_token: true, expires_in: "bad" }), { status: 200 });
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, env);

	assert.equal(child.status, 0, child.stderr);
	const { error } = JSON.parse(child.stdout.trim());
	assert.match(error, /Gemini ADC token exchange returned no access_token/);

	const expires = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "token", expires_in: "bad" }), { status: 200 });
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let error = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			error = err.message;
		}
		console.log(JSON.stringify({ error }));
	`, env);

	assert.equal(expires.status, 0, expires.stderr);
	assert.match(JSON.parse(expires.stdout.trim()).error, /Gemini ADC token exchange returned invalid expires_in/);
});

test("Gemini ADC never leaks the access token in errors", async () => {	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-redact-"));
	await writeAdc(root);
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n",
		"utf8",
	);

	const child = runChild(`
		globalThis.fetch = async (url, init = {}) => {
			if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
				return new Response(JSON.stringify({ access_token: "super-secret-adc-token-12345", expires_in: 3599 }), { status: 200 });
			}
			// Vertex returns 500 with a body that maliciously echoes the token.
			return new Response(JSON.stringify({ error: { message: "boom super-secret-adc-token-12345" } }), { status: 500 });
		};
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		let threw = null;
		try {
			await search("query", { provider: "gemini" });
		} catch (err) {
			threw = String(err.message);
		}
		console.log(JSON.stringify({ threw, leak: threw && threw.includes("super-secret-adc-token-12345") }));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.threw, "expected an error");
	assert.equal(output.leak, false, "access token must not leak in error messages");
});

test("Gemini ADC classifies only credential rejections as CredentialResolutionError", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-classify-"));
	await writeAdc(root);
	const env = { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") };

	const classify = (status, body) => runChild(`
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: ${status} });
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		let threw = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			threw = { name: err.name, category: err.category, message: err.message };
		}
		console.log(JSON.stringify({ threw }));
	`, env);

	// Credential rejections -> CredentialResolutionError.
	for (const status of [400, 401, 403]) {
		const out = classify(status, JSON.stringify({ error: "denied" }));
		assert.equal(out.status, 0, out.stderr);
		const { threw } = JSON.parse(out.stdout.trim());
		assert.equal(threw.name, "CredentialResolutionError", `status ${status}`);
		assert.equal(threw.category, "oauth-credential-rejected", `status ${status}`);
		assert.match(threw.message, /OAuth token exchange rejected/, `status ${status}`);
	}

	// Transient failures stay plain Errors so fallbacks still run.
	for (const status of [429, 404, 500, 502, 503]) {
		const out = classify(status, "upstream boom");
		assert.equal(out.status, 0, out.stderr);
		const { threw } = JSON.parse(out.stdout.trim());
		assert.equal(threw.name, "Error", `status ${status}`);
		assert.equal(threw.category, undefined, `status ${status}`);
		assert.match(threw.message, new RegExp(`token exchange failed \\(${status}\\)`), `status ${status}`);
	}
});

test("Gemini ADC does not advertise the Files-API (YouTube/video) path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-video-"));
	await writeAdc(root);
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l" }) + "\n",
		"utf8",
	);

	// ADC only: generate-content paths are available, the Files-API path is not.
	const adcOnly = runChild(`
		const api = await import(${JSON.stringify(geminiApiModuleUrl)});
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		console.log(JSON.stringify({
			adcAvail: adc.isGeminiAdcAvailable(),
			apiAvail: api.isGeminiApiAvailable(),
			videoAvail: api.isGeminiApiAvailableWithVideo(),
		}));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(adcOnly.status, 0, adcOnly.stderr);
	assert.deepEqual(JSON.parse(adcOnly.stdout.trim()), {
		adcAvail: true,
		apiAvail: true,
		videoAvail: false,
	});

	// ADC + API key: the Files-API path becomes available again.
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({ geminiAuth: "adc", geminiProject: "p", geminiLocation: "l", geminiApiKey: "synthetic-key" }) + "\n",
		"utf8",
	);
	const withKey = runChild(`
		const api = await import(${JSON.stringify(geminiApiModuleUrl)});
		console.log(JSON.stringify({
			apiAvail: api.isGeminiApiAvailable(),
			videoAvail: api.isGeminiApiAvailableWithVideo(),
		}));
	`, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root, GOOGLE_APPLICATION_CREDENTIALS: join(root, "adc.json") });
	assert.equal(withKey.status, 0, withKey.stderr);
	assert.deepEqual(JSON.parse(withKey.stdout.trim()), { apiAvail: true, videoAvail: true });
});

test("Gemini ADC falls back to the GCE metadata server when no ADC file exists", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-metadata-"));
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({
			geminiAuth: "adc",
			geminiProject: "synthetic-project",
			geminiLocation: "global",
		}) + "\n",
		"utf8",
	);

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init = {}) => {
			const request = { url: String(url), method: init.method ?? "GET", redirect: init.redirect ?? "follow", headers: Object.fromEntries(new Headers(init.headers)) };
			requests.push(request);
			if (String(url) === "http://metadata.test/computeMetadata/v1/instance/service-accounts/default/token") {
				return new Response(JSON.stringify({ access_token: "synthetic-metadata-token", expires_in: 3599 }), {
					status: 200, headers: { "content-type": "application/json" },
				});
			}
			if (String(url).includes(":generateContent")) {
				return new Response(JSON.stringify({
					candidates: [{
						content: { parts: [{ text: "Paris is the capital of France." }] },
						groundingMetadata: {
							groundingChunks: [{ web: { uri: "https://en.wikipedia.org/wiki/Paris", title: "Paris" } }],
						},
					}],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch: " + request.url);
		};
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		const avail = adc.isGeminiAdcAvailable();
		const result = await search("what is the capital of France?", { provider: "gemini" });
		console.log(JSON.stringify({ avail, result, requests }));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
		GCE_METADATA_HOST: "metadata.test",
		METADATA_SERVER_DETECTION: undefined,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.avail, true);
	assert.equal(output.result.answer, "Paris is the capital of France.");
	assert.equal(output.result.provider, "gemini");

	const oauthRequests = output.requests.filter(r => r.url.startsWith("https://oauth2.googleapis.com/token"));
	assert.equal(oauthRequests.length, 0, "must not call oauth2.googleapis.com");

	const metadataRequests = output.requests.filter(r => r.url.startsWith("http://metadata.test/"));
	assert.equal(metadataRequests.length, 1);
	assert.equal(metadataRequests[0].url, "http://metadata.test/computeMetadata/v1/instance/service-accounts/default/token");
	assert.equal(metadataRequests[0].headers["metadata-flavor"], "Google");
	assert.equal(metadataRequests[0].redirect, "error");

	const generateRequests = output.requests.filter(r => r.url.includes(":generateContent"));
	assert.equal(generateRequests.length, 1);
	assert.equal(generateRequests[0].url, "https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models/gemini-3.6-flash:generateContent");
	assert.equal(generateRequests[0].headers["authorization"], "Bearer synthetic-metadata-token");
});

test("Gemini ADC does not fall back to the metadata server when GOOGLE_APPLICATION_CREDENTIALS is set to a missing path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-missing-explicit-"));
	const missingPath = join(root, "missing-adc.json");
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({
			geminiAuth: "adc",
			geminiProject: "synthetic-project",
			geminiLocation: "global",
		}) + "\n",
		"utf8",
	);

	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init = {}) => {
			requests.push(String(url));
			throw new Error("Unexpected fetch: " + String(url));
		};
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		const api = await import(${JSON.stringify(geminiApiModuleUrl)});
		let tokenError = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			tokenError = err.message;
		}
		console.log(JSON.stringify({
			adcAvail: adc.isGeminiAdcAvailable(),
			apiAvail: api.isGeminiApiAvailable(),
			tokenError,
			requests,
		}));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
		GOOGLE_APPLICATION_CREDENTIALS: missingPath,
		GCE_METADATA_HOST: "metadata.test",
		METADATA_SERVER_DETECTION: undefined,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.adcAvail, false);
	assert.equal(output.apiAvail, false);
	assert.equal(output.requests.length, 0);
	assert.match(output.tokenError, /Google Application Default Credentials file not found at /);
	assert.match(output.tokenError, /missing-adc\.json/);
});

test("Gemini ADC metadata server 500 surfaces as a transient Error without leaking credentials", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-adc-metadata-500-"));
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({
			geminiAuth: "adc",
			geminiProject: "synthetic-project",
			geminiLocation: "global",
		}) + "\n",
		"utf8",
	);

	const child = runChild(`
		globalThis.fetch = async (url) => {
			if (String(url).startsWith("http://metadata.test/")) {
				return new Response("metadata upstream boom", { status: 500 });
			}
			throw new Error("Unexpected fetch: " + String(url));
		};
		const adc = await import(${JSON.stringify(geminiAdcModuleUrl)});
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		let tokenThrew = null;
		try {
			await adc.getAdcAccessToken();
		} catch (err) {
			tokenThrew = { name: err.name, category: err.category, message: err.message };
		}
		let searchThrew = null;
		try {
			await search("query", { provider: "gemini" });
		} catch (err) {
			searchThrew = { name: err.name, message: err.message };
		}
		console.log(JSON.stringify({ tokenThrew, searchThrew }));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
		GCE_METADATA_HOST: "metadata.test",
		METADATA_SERVER_DETECTION: undefined,
	});

	assert.equal(child.status, 0, child.stderr);
	const { tokenThrew, searchThrew } = JSON.parse(child.stdout.trim());
	assert.equal(tokenThrew.name, "Error");
	assert.equal(tokenThrew.category, undefined);
	assert.match(tokenThrew.message, /Gemini ADC metadata server token request failed \(HTTP 500\): metadata upstream boom/);
	assert.equal(searchThrew.name, "Error");
	assert.match(searchThrew.message, /Gemini API: Gemini ADC metadata server token request failed \(HTTP 500\): metadata upstream boom/);

	// Metadata 503 is classified as transient so searchRouting falls through to Brave.
	await writeFile(
		join(root, "web-search.json"),
		JSON.stringify({
			geminiAuth: "adc",
			geminiProject: "synthetic-project",
			geminiLocation: "global",
			searchRouting: { providers: ["gemini", "brave"], fallbackOn: ["transient"] },
		}) + "\n",
		"utf8",
	);
	const routeChild = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("http://metadata.test/")) {
				return new Response("metadata overloaded", { status: 503 });
			}
			if (String(url).startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({
					web: { results: [{ title: "Brave fallback", url: "https://example.com/brave", description: "ok" }] },
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch: " + String(url));
		};
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		const result = await search("query", { provider: "auto" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
		GCE_METADATA_HOST: "metadata.test",
		METADATA_SERVER_DETECTION: undefined,
		BRAVE_API_KEY: "brave-test-key",
	});
	assert.equal(routeChild.status, 0, routeChild.stderr);
	assert.deepEqual(JSON.parse(routeChild.stdout.trim()), {
		provider: "brave",
		calls: [
			"http://metadata.test/computeMetadata/v1/instance/service-accounts/default/token",
			"https://api.search.brave.com/res/v1/web/search?q=query&count=5",
		],
	});

	// Now Vertex returns 500 with a body that echoes the cached metadata token -> must be redacted.
	const redactChild = runChild(`
		globalThis.fetch = async (url) => {
			if (String(url).startsWith("http://metadata.test/")) {
				return new Response(JSON.stringify({ access_token: "secret-metadata-token-999", expires_in: 3599 }), { status: 200 });
			}
			return new Response(JSON.stringify({ error: { message: "boom secret-metadata-token-999" } }), { status: 500 });
		};
		const { search } = await import(${JSON.stringify(geminiSearchModuleUrl)});
		let threw = null;
		try {
			await search("query", { provider: "gemini" });
		} catch (err) {
			threw = String(err.message);
		}
		console.log(JSON.stringify({ threw, leak: threw && threw.includes("secret-metadata-token-999") }));
	`, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
		GCE_METADATA_HOST: "metadata.test",
		METADATA_SERVER_DETECTION: undefined,
	});
	assert.equal(redactChild.status, 0, redactChild.stderr);
	const redactOut = JSON.parse(redactChild.stdout.trim());
	assert.ok(redactOut.threw);
	assert.equal(redactOut.leak, false, "metadata access token must not leak in error messages");
});
