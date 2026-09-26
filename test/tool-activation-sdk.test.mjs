import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

const extensionPath = new URL("../index.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "pi-web-access-sdk-"));

async function runNative(config = {}, options = {}) {
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
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, additionalExtensionPaths: [options.extensionPath ?? extensionPath] });
		await loader.reload();
		const sessionManager = SessionManager.inMemory(root);
		for (const message of options.messages ?? []) sessionManager.appendMessage(message);
		const { session, extensionsResult } = await createAgentSession({
			cwd: root,
			agentDir: root,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
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
	assert.ok(requests[1].tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) <= 11_924);

	const renamed = await runNative({ toolNames: { webSearch: "research_web", sourceCheck: "verify_sources", fetchContent: "grab_content", getSearchContent: "open_content" } });
	assert.deepEqual(renamed[1].tools.map(tool => tool.name), ["web_enable", "research_web", "verify_sources", "grab_content", "open_content"]);

	const fetchOnly = await runNative({ tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } });
	assert.deepEqual(fetchOnly[0].tools.map(tool => tool.name), ["web_enable"]);
	assert.deepEqual(fetchOnly[1].tools.map(tool => tool.name), ["web_enable", "fetch_content"]);
});

test("restores a cold transcript when Pi AI is only available through the host loader", async () => {
	const isolated = mkdtempSync(join(tmpdir(), "pi-web-access-hosted-"));
	copyFileSync(new URL("../tool-activation.ts", import.meta.url), join(isolated, "tool-activation.ts"));
	// Satisfy the existing version probe without making pi-ai's subpath resolvable to Node.
	const peer = join(isolated, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(peer, "dist"), { recursive: true });
	writeFileSync(join(peer, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent", version: "0.86.1", type: "module", exports: "./dist/index.js",
	}));
	writeFileSync(join(peer, "dist", "index.js"), "export {};\n");
	const hostedExtension = join(isolated, "index.ts");
	writeFileSync(hostedExtension, `
		import { registerWebToolActivation } from "./tool-activation.ts";
		export default function (pi) {
			pi.registerTool({ name: "web_search", label: "Web Search", description: "Search", parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "done" }], details: {} }; } });
			registerWebToolActivation(pi, [{ name: "web_search", capability: "search" }]);
		}
	`);
	const requests = await runNative({}, {
		extensionPath: hostedExtension,
		messages: [{ role: "system", content: "", timestamp: 1, toolsAdded: [
			{ name: "web_enable", description: "Enable web", parameters: { type: "object", properties: {} } },
		] }],
	});
	assert.deepEqual(requests[0].tools.map(tool => tool.name), ["web_enable"]);
	assert.deepEqual(requests[1].tools.map(tool => tool.name), ["web_enable", "web_search"]);
});
