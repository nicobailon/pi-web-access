import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
// The browser helpers are replaced with POSIX shell scripts, and the fake browser uses the macOS/Linux layout.
const posixTest = process.platform === "win32" ? test.skip : test;
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// Runs the Pi extension in a child process (module state is per session) with a Chrome profile folder
// in HOME and stand-ins for every helper that reads browser secrets or cookie databases.
function runPi({ hasUI, answers = [], config, calls }) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-cookie-consent-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const helperLog = join(root, "helpers.log");
	mkdirSync(agentDir);
	mkdirSync(bin);
	const chrome = process.platform === "darwin" ? join(home, "Library", "Application Support", "Google", "Chrome") : join(home, ".config", "google-chrome");
	mkdirSync(join(chrome, "Default"), { recursive: true });
	writeFileSync(join(chrome, "Default", "Cookies"), "");
	for (const name of ["security", "secret-tool", "kwallet-query", "sqlite3", "python3", "powershell.exe"]) {
		writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${helperLog}"\nexit 1\n`);
		chmodSync(join(bin, name), 0o755);
	}
	if (config) writeFileSync(join(agentDir, "web-search.json"), JSON.stringify(config));
	writeFileSync(join(root, "clip.mp4"), "not really a video");

	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, PI_WEB_ACCESS_DISABLE_NODE_SQLITE: "1" };
	for (const name of ["GEMINI_API_KEY", "PI_ALLOW_BROWSER_COOKIES", "FEYNMAN_ALLOW_BROWSER_COOKIES", "XDG_CONFIG_HOME"]) delete env[name];
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		env,
		input: `
			globalThis.fetch = async () => { throw new Error("network disabled in test"); };
			const tools = [];
			const commands = {};
			const messages = [];
			(await import(${JSON.stringify(indexUrl)})).default({
				registerTool(t) { tools.push(t); }, registerCommand(name, c) { commands[name] = c; }, registerShortcut() {}, on() {},
				sendMessage(message) { messages.push(message.content[0].text); }, appendEntry() {},
			});
			const answers = ${JSON.stringify(answers)};
			const selects = [];
			const ctx = {
				hasUI: ${hasUI}, cwd: ${JSON.stringify(root)}, isProjectTrusted() { return true; },
				modelRegistry: { getAvailable() { return []; }, find() { return undefined; } },
				// "hang" is a dialog that never answers, even when its signal aborts.
				ui: { notify() {}, select(title, options) { selects.push({ title, options }); const answer = answers.shift(); return answer === "hang" ? new Promise(() => {}) : Promise.resolve(answer); } },
			};
			const run = (name, params) => tools.find((t) => t.name === name).execute("call", params, undefined, () => {}, ctx)
				.then((result) => ({ text: result.content.map((part) => part.text ?? "").join("\\n"), selects: selects.length }));
			const command = (name) => commands[name].handler("", ctx).then(() => ({ text: messages.at(-1), selects: selects.length }));
			const video = ${JSON.stringify(join(root, "clip.mp4"))};
			const results = [];
			${calls}
			console.log(JSON.stringify(results));
		`,
	});
	assert.equal(child.status, 0, child.stderr);
	const configPath = join(agentDir, "web-search.json");
	return {
		results: JSON.parse(child.stdout.trim().split("\n").at(-1)),
		config: existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null,
		helpers: existsSync(helperLog) ? readFileSync(helperLog, "utf8").trim().split("\n") : [],
	};
}

const fetchVideoTwice = `results.push(await run("fetch_content", { url: video })); results.push(await run("fetch_content", { url: video }));`;

posixTest("without a UI, video analysis names the browsers found and reads no browser data", () => {
	const { results: [result], helpers } = runPi({ hasUI: false, calls: `results.push(await run("fetch_content", { url: video }));` });
	assert.equal(result.selects, 0);
	assert.match(result.text, /Found on this machine: Chrome \(Default\)/);
	assert.match(result.text, /"allowBrowserCookies": true, "browserCookies": \{ "browser": "chrome" \}, or run \/google-account/);
	assert.match(result.text, /ask the user first, and don't change this setting yourself/);
	assert.deepEqual(helpers, []);
});

posixTest("\"Yes, this session\" reads the browser cookies right away and saves nothing", () => {
	const { results, config, helpers } = runPi({ hasUI: true, answers: ["Yes, this session"], calls: fetchVideoTwice });
	assert.deepEqual(results.map((result) => result.selects), [1, 1]);
	assert.ok(helpers.length > 0, "the retried Gemini Web route reads the cookie database");
	assert.equal(config, null);
});

posixTest("\"Yes, always\" saves browser cookie access and the chosen browser", () => {
	const { config } = runPi({ hasUI: true, answers: ["Yes, always (saves to web-search.json)"], config: { workflow: "none" }, calls: fetchVideoTwice });
	assert.deepEqual(config, { workflow: "none", allowBrowserCookies: true, browserCookies: { browser: "chrome" } });
});

posixTest("\"No\" returns the setup hint and is not asked again this session", () => {
	const { results, config, helpers } = runPi({ hasUI: true, answers: ["No"], calls: fetchVideoTwice });
	assert.deepEqual(results.map((result) => result.selects), [1, 1]);
	assert.match(results[1].text, /reading browser cookies is off/);
	assert.equal(config, null);
	assert.deepEqual(helpers, []);
});

posixTest("web_search asks only when Gemini was requested, never during automatic provider selection", () => {
	const { results } = runPi({
		hasUI: true,
		answers: ["No"],
		config: { workflow: "none" },
		calls: `results.push(await run("web_search", { query: "q" })); results.push(await run("web_search", { query: "q", provider: "gemini" }));`,
	});
	assert.deepEqual(results.map((result) => result.selects), [0, 1]);
	assert.match(results[1].text, /reading browser cookies is off/);
});

posixTest("aborting a tool call while the question is open ends the call, and a later call asks again", () => {
	const { results } = runPi({
		hasUI: true,
		answers: ["hang", "No"],
		calls: `
			const controller = new AbortController();
			const pending = tools.find((t) => t.name === "fetch_content").execute("call", { url: video }, controller.signal, () => {}, ctx)
				.then((result) => result.content.map((part) => part.text ?? "").join("\\n"), (err) => String(err));
			while (selects.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
			const started = Date.now();
			controller.abort();
			results.push({ text: await pending, ms: Date.now() - started });
			results.push(await run("fetch_content", { url: video }));
		`,
	});
	assert.match(results[0].text, /abort/i);
	assert.ok(results[0].ms < 2000, `settled ${results[0].ms}ms after the abort`);
	assert.equal(results[1].selects, 2, "an abort is not a No, so the next call asks again");
});

posixTest("/google-account turns browser cookie access on, then off", () => {
	const { results, config } = runPi({
		hasUI: true,
		answers: ["Yes, always (saves to web-search.json)", "Turn it off"],
		calls: `results.push(await command("google-account")); results.push(await command("google-account"));`,
	});
	assert.deepEqual(results.map((result) => result.selects), [1, 2]);
	assert.match(results[1].text, /Browser cookie access is off/);
	assert.deepEqual(config, { allowBrowserCookies: false, browserCookies: { browser: "chrome" } });
});

posixTest("\"Yes, this session\" keeps the configured profile of the chosen browser", () => {
	// Profile 2 has no cookie database here, so keeping it means no browser data is read; dropping it would read Default.
	const { helpers } = runPi({ hasUI: true, answers: ["Yes, this session"], config: { browserCookies: { browser: "chrome", profile: "Profile 2" } }, calls: `results.push(await run("fetch_content", { url: video }));` });
	assert.deepEqual(helpers, []);
});

posixTest("an explicit Gemini search still asks when the Gemini API fails", () => {
	const { results } = runPi({ hasUI: true, answers: ["No"], config: { geminiApiKey: "test-key" }, calls: `results.push(await run("web_search", { query: "q", provider: "gemini" }));` });
	assert.equal(results[0].selects, 1);
	assert.match(results[0].text, /Gemini API: .*network disabled in test/);
});
