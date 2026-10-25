import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const keys = { openaiApiKey: "openai-key", xaiApiKey: "xai-key", mistralApiKey: "mistral-key", geminiApiKey: "gemini-key" };
const configured = { openaiSearchModel: "configured-openai", xaiSearchModel: "configured-xai", mistralSearchModel: "configured-mistral", searchModel: "configured-gemini" };
// Replaces the browser-cookie Gemini Web client so a test can see whether it was used.
const geminiWebStub = `
	export const isGeminiWebAvailable = async () => { globalThis.browserCalls++; return { cookie: "present" }; };
	export const queryWithCookies = async () => { globalThis.browserCalls++; return "Browser answer"; };
	export const getGeminiWebAvailabilityDiagnostic = () => null;
	export const getGeminiWebAvailabilityDiagnosticDetails = () => null;
	export const getActiveGoogleEmail = async () => null;
`;
const loader = `export async function resolve(s, c, next) {
	if (s.endsWith("/gemini-web.ts")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(geminiWebStub))}, shortCircuit: true };
	return next(s, c);
}`;

// Runs `body` with the registered web_search tool as `tool`; returns the requests it sent.
function run(config, body) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-search-model-"));
	try {
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ autoOpenBrowser: false, ...config }));
		const env = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: "" };
		for (const key of Object.keys(env)) if (/_API_KEY$|^GOOGLE_/.test(key)) delete env[key];
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			encoding: "utf8",
			env,
			input: `
				import assert from "node:assert/strict";
				import { register } from "node:module";
				register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
				globalThis.browserCalls = 0;
				const requests = [];
				globalThis.fetch = async (input, init = {}) => {
					const url = String(input);
					requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
					if (url.includes(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ text: "Gemini answer" }] } }] });
					if (url.includes("/conversations")) return Response.json({ outputs: [{ type: "message.output", content: "Mistral answer" }] });
					return Response.json({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "Responses answer" }] }] });
				};
				const tools = [];
				(await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
				const tool = tools.find(t => t.name === "web_search");
				${body}
				console.log(JSON.stringify(requests));
			`,
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim().split("\n").at(-1));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const sentModel = request => request.body?.model ?? decodeURIComponent(request.url.match(/models\/(.*):generateContent/)[1]);

for (const provider of ["openai", "xai", "mistral", "gemini"]) {
	test(`${provider}: a per-call model overrides the configured model for that call only`, () => {
		const requests = run({ ...keys, ...configured }, `
			for (const result of [
				await tool.execute("a", { query: "q", provider: "${provider}", model: " Exact-ID " }),
				await tool.execute("b", { query: "q", provider: "${provider}" }),
			]) {
				assert.notEqual(result.isError, true, result.content[0].text);
				assert.match(result.content[0].text, /answer/);
			}
		`);
		assert.deepEqual(requests.map(sentModel), ["Exact-ID", `configured-${provider}`]);
		if (provider === "gemini") assert.equal(requests[0].url.replace("Exact-ID", "configured-gemini"), requests[1].url);
		else assert.deepEqual({ ...requests[0].body, model: `configured-${provider}` }, requests[1].body);
	});
}

test("model is rejected before any request without one explicit supported provider", () => {
	const requests = run({ ...keys, provider: "openai", braveApiKey: "brave-key" }, `
		for (const params of [{}, { provider: "auto" }, { provider: "all" }, { provider: "brave" }]) {
			await assert.rejects(tool.execute("x", { query: "q", model: "m", ...params }), /^Error: model (requires one explicit provider|is not supported)/);
		}
		for (const provider of [["openai", "xai"], "openai,xai"]) {
			await assert.rejects(tool.execute("x", { query: "q", model: "m", provider }), /provider lists are ambiguous/);
		}
		await assert.rejects(tool.execute("x", { query: "q", provider: "openai", model: "  " }), /non-empty model ID/);
		const curated = await tool.execute("x", { query: "q", provider: "openai", model: "m", workflow: "summary-review" }, undefined, undefined, {});
		assert.match(curated.content[0].text, /model cannot be used with workflow "summary-review"/);
		assert.equal(curated.isError, true);
	`);
	assert.deepEqual(requests, []);
});

test("a Gemini model override fails instead of falling back to browser cookies", () => {
	const requests = run({}, `
		const result = await tool.execute("x", { query: "q", provider: "gemini", model: "m" });
		assert.match(result.content[0].text, /explicit model requires API-path authentication/);
		assert.equal(globalThis.browserCalls, 0);
	`);
	assert.deepEqual(requests, []);
});
