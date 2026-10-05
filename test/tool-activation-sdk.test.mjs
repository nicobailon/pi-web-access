import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

const extensionPath = new URL("../index.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "pi-web-access-sdk-"));

async function withNativeEnv(config, run) {
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config), "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFauxKey = process.env.FAUX_API_KEY;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.FAUX_API_KEY = "test";
	try {
		return await run();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousFauxKey === undefined) delete process.env.FAUX_API_KEY;
		else process.env.FAUX_API_KEY = previousFauxKey;
	}
}

function nativeHarness({ api, compat } = {}) {
	const faux = fauxProvider({ api });
	const models = createModels();
	models.setProvider(faux.provider);
	const modelRuntime = new Proxy(models, {
		get(target, property) {
			if (property === "hasConfiguredAuth") return () => true;
			if (property === "checkAuth") return async () => ({ type: "api_key", key: "test" });
			if (property === "isUsingOAuth" || property === "isUsingSubscription") return () => false;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const requests = [];
	const captureRequest = (context) => requests.push({
		tools: getCurrentTools(context.messages),
		systemText: context.messages.filter(message => message.role === "system").map(getSystemMessageText).join("\n\n"),
	});
	async function start({ extensions, sessionManager, reason, noTools }) {
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, additionalExtensionPaths: extensions ? [extensionPath] : [], noExtensions: !extensions });
		await loader.reload();
		const { session, extensionsResult } = await createAgentSession({
			cwd: root,
			agentDir: root,
			model: { ...faux.getModel(), compat },
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason },
			noTools,
		});
		assert.deepEqual(extensionsResult.errors, []);
		await session.bindExtensions({});
		return session;
	}
	return { faux, requests, captureRequest, start };
}

async function runNative(config = {}) {
	return withNativeEnv({ toolActivation: "dynamic", ...config }, async () => {
		const { faux, requests, captureRequest, start } = nativeHarness();
		faux.setResponses([
			(context) => {
				captureRequest(context);
				return fauxAssistantMessage(fauxToolCall("web_enable", {}), { stopReason: "toolUse" });
			},
			(context) => {
				captureRequest(context);
				return fauxAssistantMessage("done");
			},
		]);
		const session = await start({ extensions: true, sessionManager: SessionManager.inMemory(root), reason: "startup", noTools: "builtin" });
		await session.prompt("Research this");
		session.dispose();
		return requests;
	});
}

test("native Pi sends configured web schemas on the request immediately after activation", async () => {
	const requests = await runNative();
	assert.match(requests[0].systemText, /pi-web-access/i);
	assert.match(requests[0].systemText, /call web_enable/i);
	assert.deepEqual(requests[0].tools.map(tool => tool.name), ["web_enable"]);
	assert.deepEqual(requests[1].tools.map(tool => tool.name), ["web_enable", "web_search", "source_check", "fetch_content", "get_search_content"]);
	assert.ok(requests[0].tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) <= 700);
	assert.ok(requests[1].tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) <= 12_043);

	const renamed = await runNative({ toolNames: { webSearch: "research_web", sourceCheck: "verify_sources", fetchContent: "grab_content", getSearchContent: "open_content" } });
	assert.deepEqual(renamed[1].tools.map(tool => tool.name), ["web_enable", "research_web", "verify_sources", "grab_content", "open_content"]);

	const fetchOnly = await runNative({ tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } });
	assert.deepEqual(fetchOnly[0].tools.map(tool => tool.name), ["web_enable"]);
	assert.deepEqual(fetchOnly[1].tools.map(tool => tool.name), ["web_enable", "fetch_content"]);
});

test("native Pi on a model without native tool additions starts with every web tool and no web_enable", async () => {
	const requests = await withNativeEnv({}, async () => {
		const { faux, requests, captureRequest, start } = nativeHarness();
		faux.setResponses([(context) => {
			captureRequest(context);
			return fauxAssistantMessage("done");
		}]);
		const session = await start({ extensions: true, sessionManager: SessionManager.inMemory(root), reason: "startup", noTools: "builtin" });
		await session.prompt("Research this");
		session.dispose();
		return requests;
	});
	assert.deepEqual(requests[0].tools.map(tool => tool.name), ["web_search", "source_check", "fetch_content", "get_search_content"]);
	assert.doesNotMatch(requests[0].systemText, /web_enable/);
});

test("native Pi on a model with native tool additions starts with web_enable by default", async () => {
	const requests = await withNativeEnv({}, async () => {
		const { faux, requests, captureRequest, start } = nativeHarness({
			api: "anthropic-messages",
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
		});
		faux.setResponses([(context) => {
			captureRequest(context);
			return fauxAssistantMessage("done");
		}]);
		const session = await start({ extensions: true, sessionManager: SessionManager.inMemory(root), reason: "startup", noTools: "builtin" });
		await session.prompt("Research this");
		session.dispose();
		return requests;
	});
	assert.deepEqual(requests[0].tools.map(tool => tool.name), ["web_enable"]);
});

test("native Pi resumes a session recorded without pi-web-access with its recorded tools", async () => {
	const requests = await withNativeEnv({}, async () => {
		const { faux, requests, captureRequest, start } = nativeHarness();
		const reply = (context) => {
			captureRequest(context);
			return fauxAssistantMessage("ok");
		};
		faux.setResponses([reply, reply]);
		const sessionManager = SessionManager.inMemory(root);
		const before = await start({ extensions: false, sessionManager, reason: "startup" });
		await before.prompt("first turn");
		before.dispose();
		const resumed = await start({ extensions: true, sessionManager, reason: "resume" });
		await resumed.prompt("second turn");
		resumed.dispose();
		return requests;
	});
	const recorded = requests[0].tools.map(tool => tool.name);
	assert.ok(recorded.length > 0);
	assert.deepEqual(requests[1].tools.map(tool => tool.name), recorded);
});
