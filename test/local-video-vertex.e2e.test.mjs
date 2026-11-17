import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Agent, setGlobalDispatcher } from "undici";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

const analysis = "# Owned audiovisual fixture\n00:00-00:05: moving test pattern and continuous sine audio.";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function runNativeScenario() {
	const scenario = process.env.VIDEO_E2E_SCENARIO;
	const root = process.env.PI_CODING_AGENT_DIR;
	const video = process.env.VIDEO_E2E_FIXTURE;
	const original = await readFile(video);
	const requests = [];
	let session;
	let generationStarted;
	let generationClosed;
	const started = new Promise(resolve => { generationStarted = resolve; });
	const closed = new Promise(resolve => { generationClosed = resolve; });
	const server = createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const bytes = Buffer.concat(chunks);
		const request = { host: req.headers.host, path: req.url, method: req.method, headers: { ...req.headers } };
		if (request.headers.authorization) request.headers.authorization = request.headers.authorization === "Bearer owned-access-token" ? "Bearer [owned test token]" : "unexpected";
		requests.push(request);
		res.setHeader("Content-Type", "application/json");
		if (req.headers.host === "oauth2.googleapis.com") {
			assert.equal(req.url, "/token");
			assert.equal(req.method, "POST");
			const form = new URLSearchParams(bytes.toString());
			assert.equal(form.get("refresh_token"), "owned-refresh-token");
			assert.equal(form.get("grant_type"), "refresh_token");
			res.statusCode = scenario === "adc-denied" ? 400 : 200;
			res.end(JSON.stringify(scenario === "adc-denied" ? { error: "owned-refresh-token" } : { access_token: "owned-access-token", expires_in: 3600 }));
			return;
		}
		if (req.url === "/upload/v1beta/files") {
			res.setHeader("x-goog-upload-url", "https://generativelanguage.googleapis.com/upload/owned");
			res.end("{}");
			return;
		}
		if (req.url === "/upload/owned") {
			assert.equal(digest(bytes), digest(original));
			res.end(JSON.stringify({ file: { name: "files/owned", uri: "https://generativelanguage.googleapis.com/v1beta/files/owned" } }));
			return;
		}
		if (req.url === "/v1beta/files/owned") {
			if (req.method === "DELETE") { res.statusCode = 204; res.end(); }
			else res.end(JSON.stringify({ state: "ACTIVE" }));
			return;
		}
		if (req.url.includes(":generateContent")) {
			const body = JSON.parse(bytes.toString());
			const part = body.contents[0].parts[0];
			request.requestBytes = bytes.length;
			request.prompt = body.contents[0].parts[1].text;
			if (part.inlineData) {
				const media = Buffer.from(part.inlineData.data, "base64");
				request.mediaBytes = media.length;
				request.mediaSha256 = digest(media);
				request.mimeType = part.inlineData.mimeType;
				assert.equal(digest(media), digest(original));
				assert.equal(part.inlineData.mimeType, "video/quicktime");
			} else {
				assert.equal(part.fileData.fileUri, "https://generativelanguage.googleapis.com/v1beta/files/owned");
			}
			generationStarted();
			if (scenario === "cancel" || scenario === "timeout") {
				res.once("close", () => { request.connectionClosed = true; generationClosed(); });
				return;
			}
			if (scenario.startsWith("http-")) {
				res.statusCode = Number(scenario.slice(5));
				res.end(JSON.stringify({ error: { message: "owned-access-token owned-refresh-token" } }));
				return;
			}
			if (scenario === "invalid") { res.end("not JSON owned-access-token"); return; }
			if (scenario === "empty") { res.end("{}"); return; }
			if (scenario === "blocked") { res.end(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })); return; }
			res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: analysis }] }, finishReason: scenario === "truncated" ? "MAX_TOKENS" : "STOP" }] }));
			return;
		}
		res.statusCode = 500;
		res.end("Unexpected service path");
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const dispatcher = new Agent({ connect(options, callback) {
		if (!["oauth2.googleapis.com", "aiplatform.googleapis.com", "us-central1-aiplatform.googleapis.com", "generativelanguage.googleapis.com"].includes(options.hostname)) {
			callback(new Error("Non-owned network blocked"));
			return;
		}
		const socket = connect({ host: "127.0.0.1", port: server.address().port, rejectUnauthorized: false }, () => callback(null, socket));
		socket.once("error", callback);
	} });
	setGlobalDispatcher(dispatcher);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const modelRuntime = new Proxy(models, { get(target, key) {
		if (key === "hasConfiguredAuth") return () => true;
		if (key === "checkAuth") return async () => ({ type: "api_key", key: "owned-faux-key" });
		if (key === "isUsingOAuth" || key === "isUsingSubscription") return () => false;
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("fetch_content", { url: video, prompt: "Describe the complete timeline and audio", model: "owned-model" }), { stopReason: "toolUse" }),
		() => fauxAssistantMessage("done"),
	]);
	const extension = resolve(process.env.VIDEO_E2E_SOURCE ?? fileURLToPath(new URL("..", import.meta.url)), "index.ts");
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, additionalExtensionPaths: [extension] });
	try {
		await loader.reload();
		const created = await createAgentSession({ cwd: root, agentDir: root, model: faux.getModel(), modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
		assert.deepEqual(created.extensionsResult.errors, []);
		session = created.session;
		await session.bindExtensions({});
		const startTime = Date.now();
		const prompt = session.prompt("Analyze my owned local video with fetch_content");
		if (scenario === "cancel") {
			await started;
			await session.abort();
		}
		await prompt;
		if (scenario === "cancel" || scenario === "timeout") await closed;
		const elapsedMs = Date.now() - startTime;
		const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "fetch_content");
		assert.ok(result, JSON.stringify(session.messages));
		console.log(JSON.stringify({ scenario, elapsedMs, result, requests, fixture: { bytes: original.length, sha256: digest(original) } }));
	} finally {
		session?.dispose();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		await dispatcher.destroy();
	}
}

if (process.env.VIDEO_E2E_SCENARIO) {
	await runNativeScenario();
} else {
	test("native Pi local-video journeys use full inline Vertex media or unchanged Developer Files transport", { timeout: 180000 }, async t => {
		const root = await mkdtemp(join(tmpdir(), "pi-vertex-video-e2e-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const video = join(root, "owned-av.mov");
		execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:v", "rawvideo", "-pix_fmt", "uyvy422", "-threads", "1", "-c:a", "pcm_s16le", "-shortest", video], { timeout: 30000 });
		const streams = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-show_streams", "-show_format", "-of", "json", video], { encoding: "utf8" }));
		assert.equal(streams.streams.find(stream => stream.codec_type === "video").nb_frames, "150");
		assert.equal(streams.streams.find(stream => stream.codec_type === "audio").codec_name, "pcm_s16le");
		assert.equal(Number(streams.format.duration), 5);
		assert.ok((await stat(video)).size > 55 * 1024 * 1024);
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-subj", "/CN=owned-local-test", "-days", "1"], { stdio: "ignore", timeout: 10000 });
		await writeFile(join(root, "adc.json"), JSON.stringify({ type: "authorized_user", client_id: "owned-client", client_secret: "owned-client-secret", refresh_token: "owned-refresh-token", quota_project_id: "owned-adc-quota" }));
		const evidence = [];
		const scenarios = process.env.VIDEO_E2E_BASELINE ? ["developer", "adc-only", "success"] : ["success", "adc-only", "key-command", "regional", "env-quota", "gateway-decoy", "developer", "over-cap", "request-cap", "missing-project", "missing-adc", "adc-denied", "http-401", "http-403", "http-429", "http-500", "invalid", "empty", "blocked", "truncated", "timeout", "cancel"];
		for (const scenario of scenarios) {
			await t.test(scenario, async () => {
				await writeFile(join(root, "web-search.json"), JSON.stringify({ toolActivation: "eager", allowBrowserCookies: false, ...(scenario === "developer" ? { geminiApiKey: "owned-developer-key" } : { geminiAuth: "adc", geminiProject: scenario === "missing-project" ? undefined : "owned-project", geminiLocation: scenario === "regional" ? "us-central1" : "global", geminiApiKey: scenario === "adc-only" ? undefined : scenario === "key-command" ? "!exit 37" : "owned-decoy-key" }), video: { maxSizeMB: scenario === "over-cap" ? 50 : 128, maxRequestSizeMB: scenario === "request-cap" ? 64 : 192, timeoutMs: scenario === "timeout" ? 1500 : 30000 } }));
				const env = { ...process.env, PI_CODING_AGENT_DIR: root, VIDEO_E2E_SCENARIO: scenario, VIDEO_E2E_FIXTURE: video, GOOGLE_APPLICATION_CREDENTIALS: join(root, scenario === "missing-adc" ? "absent.json" : "adc.json"), METADATA_SERVER_DETECTION: "none", FAUX_API_KEY: "owned-faux-key" };
				for (const key of Object.keys(env)) if (/_PROXY$/i.test(key) || ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "CLOUDFLARE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT", "GCE_METADATA_HOST", "PI_WEB_ACCESS_CACHE_ROOT"].includes(key)) delete env[key];
				if (scenario === "env-quota") env.GOOGLE_CLOUD_QUOTA_PROJECT = "owned-env-quota";
				if (scenario === "gateway-decoy") {
					env.GOOGLE_GEMINI_BASE_URL = "https://gateway.ai.cloudflare.com/v1/owned";
					env.CLOUDFLARE_API_KEY = "!this-command-must-not-run";
				}
				const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
				assert.equal(child.status, 0, child.stderr);
				const output = JSON.parse(child.stdout.trim().split("\n").at(-1));
				evidence.push(output);
				if (process.env.VIDEO_E2E_EVIDENCE) await writeFile(process.env.VIDEO_E2E_EVIDENCE, JSON.stringify({ streams, journeys: evidence }, null, 2));
				const text = output.result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
				assert.doesNotMatch(text, /owned-access-token|owned-refresh-token|missing.*key|sign.in/i);
				const generates = output.requests.filter(request => request.path.includes(":generateContent"));
				if (scenario === "developer") {
					assert.equal(output.result.isError, false);
					assert.match(text, /00:00-00:05/);
					assert.deepEqual(output.requests.map(request => request.method), ["POST", "PUT", "GET", "POST", "DELETE"]);
					assert.ok(output.requests.every(request => request.host === "generativelanguage.googleapis.com" && request.headers["x-goog-api-key"] === "owned-developer-key"));
				} else {
					assert.ok(output.requests.every(request => !request.headers["x-goog-api-key"] && !request.host.includes("generativelanguage") && !request.host.includes("gemini.google")));
					if (["success", "adc-only", "key-command", "regional", "env-quota", "gateway-decoy", "truncated"].includes(scenario)) {
						assert.equal(output.result.isError, false, text);
						assert.match(text, /00:00-00:05/);
						assert.match(text, scenario === "truncated" ? /Vertex finish reason: MAX_TOKENS/ : /Vertex finish reason: STOP/);
					} else {
						assert.equal(output.result.isError, true, text);
						const expected = { "over-cap": /above configured video.maxSizeMB/, "request-cap": /request size exceeds/, "missing-project": /project\/location configuration failed/, "missing-adc": /ADC authentication failed/, "adc-denied": /ADC authentication failed/, "http-401": /authentication failed \(HTTP 401\)/, "http-403": /permission\/quota-project failed \(HTTP 403\)/, "http-429": /provider failed \(HTTP 429\)/, "http-500": /provider failed \(HTTP 500\)/, invalid: /provider response failed/, empty: /no analysis text/, blocked: /blocked the prompt/, timeout: /timeout/, cancel: /cancel|abort/i };
						assert.match(text, expected[scenario]);
					}
					if (["over-cap", "request-cap", "missing-project", "missing-adc", "adc-denied"].includes(scenario)) assert.equal(generates.length, 0);
					else {
						assert.equal(generates.length, 1);
						assert.equal(output.requests.length, 2);
						assert.equal(output.requests[0].host, "oauth2.googleapis.com");
						const request = generates[0];
						assert.equal(request.host, scenario === "regional" ? "us-central1-aiplatform.googleapis.com" : "aiplatform.googleapis.com");
						assert.equal(request.path, `/v1/projects/owned-project/locations/${scenario === "regional" ? "us-central1" : "global"}/publishers/google/models/owned-model:generateContent`);
						assert.equal(request.mediaBytes, output.fixture.bytes);
						assert.equal(request.mediaSha256, output.fixture.sha256);
						assert.equal(request.headers.authorization, "Bearer [owned test token]");
						assert.equal(request.headers["x-goog-user-project"], scenario === "env-quota" ? "owned-env-quota" : "owned-adc-quota");
						assert.equal(request.prompt, "Describe the complete timeline and audio");
						if (scenario === "cancel" || scenario === "timeout") {
							assert.equal(request.connectionClosed, true);
							assert.ok(output.elapsedMs < 6000, `${scenario} took ${output.elapsedMs}ms`);
						}
					}
				}
			});
		}
	});
}
