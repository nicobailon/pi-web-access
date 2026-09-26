import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

const extensionPath = new URL("../index.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "pi-web-access-sdk-"));

async function runNative(config = {}) {
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config), "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFauxKey = process.env.FAUX_API_KEY;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.FAUX_API_KEY = "test";
	try {
		const faux = fauxProvider();
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
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, additionalExtensionPaths: [extensionPath] });
		await loader.reload();
		const { session, extensionsResult } = await createAgentSession({
			cwd: root,
			agentDir: root,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			sessionStartEvent: { type: "session_start", reason: "startup" },
			noTools: "builtin",
		});
		assert.deepEqual(extensionsResult.errors, []);
		await session.bindExtensions({});
		await session.prompt("Research this");
		session.dispose();
		return requests;
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousFauxKey === undefined) delete process.env.FAUX_API_KEY;
		else process.env.FAUX_API_KEY = previousFauxKey;
	}
}

test("native Pi sends configured web schemas on the request immediately after activation", async () => {
	const requests = await runNative();
	assert.match(requests[0].systemText, /pi-web-access/i);
	assert.match(requests[0].systemText, /call web_enable/i);
	assert.deepEqual(requests[0].tools.map(tool => tool.name), ["web_enable"]);
	assert.deepEqual(requests[1].tools.map(tool => tool.name), ["web_enable", "web_search", "source_check", "fetch_content", "get_search_content"]);
	assert.ok(requests[0].tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) <= 700);
	assert.ok(requests[1].tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) <= 12_000);

	const renamed = await runNative({ toolNames: { webSearch: "research_web", sourceCheck: "verify_sources", fetchContent: "grab_content", getSearchContent: "open_content" } });
	assert.deepEqual(renamed[1].tools.map(tool => tool.name), ["web_enable", "research_web", "verify_sources", "grab_content", "open_content"]);

	const fetchOnly = await runNative({ tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } });
	assert.deepEqual(fetchOnly[0].tools.map(tool => tool.name), ["web_enable"]);
	assert.deepEqual(fetchOnly[1].tools.map(tool => tool.name), ["web_enable", "fetch_content"]);
});
