import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../gemini-web-config.ts", import.meta.url).href;
const geminiWebUrl = new URL("../gemini-web.ts", import.meta.url).href;

function runCookieAccessCheck(home, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `const { isBrowserCookieAccessAllowed } = await import(${JSON.stringify(moduleUrl)}); console.log(String(isBrowserCookieAccessAllowed()));`,
		encoding: "utf8",
		env,
	});
}

function runBrowserCookieConfig(home) {
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: `const { getBrowserCookieSelectionFromConfig } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(getBrowserCookieSelectionFromConfig()));`,
		encoding: "utf8",
		env,
	});
}

test("Gemini Web never forwards browser cookies across origins", async () => {
	const { getActiveGoogleEmail, setGeminiFetchOverrideForTests } = await import(geminiWebUrl);
	const calls = [];
	setGeminiFetchOverrideForTests(async (url, init = {}) => {
		calls.push({ url: String(url), cookie: init.headers?.cookie, redirect: init.redirect });
		if (String(url).startsWith("https://gemini.google.com/") || String(url).startsWith("https://accounts.google.com/")) {
			return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
		}
		throw new Error(`Unexpected cross-origin request: ${url}`);
	});
	try {
		const email = await getActiveGoogleEmail({ "__Secure-1PSID": "sensitive-cookie" });
		assert.equal(email, null);
		assert.equal(calls.some((call) => call.url.startsWith("https://attacker.example/")), false);
		assert.equal(calls.every((call) => call.redirect === "manual"), true);
	} finally {
		setGeminiFetchOverrideForTests(null);
	}
});

test("Gemini Web generation rejects automatic redirects", async () => {
	const { queryWithCookies, setGeminiFetchOverrideForTests } = await import(geminiWebUrl);
	setGeminiFetchOverrideForTests(async (url, init = {}) => {
		if (String(url) === "https://gemini.google.com/app") {
			return new Response('"SNlM0e":"test-token"', { status: 200 });
		}
		if (String(url).includes("BardFrontendService/StreamGenerate")) {
			assert.equal(init.redirect, "error");
			throw new Error("generation transport reached");
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	try {
		await assert.rejects(
			queryWithCookies("search", { "__Secure-1PSID": "cookie" }, { model: "gemini-3.1-pro" }),
			/generation transport reached/,
		);
	} finally {
		setGeminiFetchOverrideForTests(null);
	}
});

test("Gemini Web rejects unsupported models instead of falling back to 2.5 Flash", async () => {
	const { queryWithCookies, setGeminiFetchOverrideForTests } = await import(geminiWebUrl);
	setGeminiFetchOverrideForTests(async () => {
		throw new Error("transport should not be reached");
	});
	try {
		await assert.rejects(
			queryWithCookies("search", { "__Secure-1PSID": "cookie" }, { model: "gemini-3.6-flash" }),
			/Gemini Web does not support model gemini-3\.6-flash/,
		);
	} finally {
		setGeminiFetchOverrideForTests(null);
	}
});

test("Gemini Web file uploads read the file and reject automatic redirects", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-upload-"));
	const filePath = join(dir, "sample.txt");
	await writeFile(filePath, "sample", "utf8");
	const { queryWithCookies, setGeminiFetchOverrideForTests } = await import(geminiWebUrl);
	setGeminiFetchOverrideForTests(async (url, init = {}) => {
		if (String(url) === "https://gemini.google.com/app") {
			return new Response('"SNlM0e":"test-token"', { status: 200 });
		}
		if (String(url) === "https://content-push.googleapis.com/upload") {
			assert.equal(init.redirect, "error");
			assert.match(Buffer.from(init.body).toString("utf8"), /filename="sample\.txt"\r\nContent-Type: text\/plain\r\n/);
			throw new Error("upload transport reached");
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	try {
		await assert.rejects(
			queryWithCookies("inspect file", { "__Secure-1PSID": "cookie" }, { files: [{ path: filePath, mimeType: "text/plain" }], model: "gemini-3.1-pro" }),
			/upload transport reached/,
		);
	} finally {
		setGeminiFetchOverrideForTests(null);
		await rm(dir, { recursive: true, force: true });
	}
});

test("Gemini Web file uploads send the file type and reference the file by name", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-upload-"));
	const filePath = join(dir, "recording.mp4");
	await writeFile(filePath, "fake-mp4-bytes", "utf8");
	const { queryWithCookies, setGeminiFetchOverrideForTests } = await import(geminiWebUrl);
	let uploadBody = "";
	let fReq = "";
	setGeminiFetchOverrideForTests(async (url, init = {}) => {
		if (String(url) === "https://gemini.google.com/app") {
			return new Response('"SNlM0e":"test-token"', { status: 200 });
		}
		if (String(url) === "https://content-push.googleapis.com/upload") {
			uploadBody = Buffer.from(init.body).toString("utf8");
			return new Response("/contrib_service/upload-id", { status: 200 });
		}
		if (String(url).includes("BardFrontendService/StreamGenerate")) {
			fReq = new URLSearchParams(init.body).get("f.req");
			throw new Error("generation transport reached");
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	try {
		await assert.rejects(
			queryWithCookies("describe", { "__Secure-1PSID": "cookie" }, {
				files: [{ path: filePath, mimeType: "video/mp4" }],
				model: "gemini-3.1-pro",
			}),
			/generation transport reached/,
		);
	} finally {
		setGeminiFetchOverrideForTests(null);
		await rm(dir, { recursive: true, force: true });
	}
	assert.match(uploadBody, /filename="recording\.mp4"\r\nContent-Type: video\/mp4\r\n/);
	const promptPayload = JSON.parse(JSON.parse(fReq)[1])[0];
	assert.deepEqual(promptPayload, ["describe", 0, null, [[["/contrib_service/upload-id", 1], "recording.mp4"]]]);
});

test("browser cookie access is disabled unless explicitly allowed", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-cookie-opt-in-"));

	let child = runCookieAccessCheck(home);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "web-search.json"), JSON.stringify({ allowBrowserCookies: true }) + "\n", "utf8");

	child = runCookieAccessCheck(home);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const envHome = await mkdtemp(join(tmpdir(), "pi-web-access-cookie-env-"));
	child = runCookieAccessCheck(envHome, { PI_ALLOW_BROWSER_COOKIES: "1" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("disabled browser cookie access does not validate legacy profile selection", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-cookie-legacy-disabled-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "web-search.json"), JSON.stringify({ chromeProfile: "Profile 1" }) + "\n", "utf8");

	const child = runCookieAccessCheck(home);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");
});

test("browser cookie config validates presets and rejects arbitrary profile paths", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-browser-cookie-config-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	const configPath = join(home, ".pi", "agent", "web-search.json");
	await writeFile(configPath, JSON.stringify({ browserCookies: { browser: "Helium", profile: "Profile 1" } }) + "\n", "utf8");

	let child = runBrowserCookieConfig(home);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { browser: "helium", profile: "Profile 1" });

	await writeFile(configPath, JSON.stringify({ chromeProfile: "Profile 1", allowBrowserCookies: true }) + "\n", "utf8");
	child = runBrowserCookieConfig(home);
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /chromeProfile.*no longer supported.*browserCookies\.profile/);

	await writeFile(configPath, JSON.stringify({ browserCookies: { browser: "safari", profile: "Profile 1" } }) + "\n", "utf8");
	child = runBrowserCookieConfig(home);
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /Unsupported browserCookies\.browser/);

	await writeFile(configPath, JSON.stringify({ browserCookies: { browser: "helium", profile: 1 } }) + "\n", "utf8");
	child = runBrowserCookieConfig(home);
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /browserCookies\.profile.*must be a profile directory name/);

	await writeFile(configPath, JSON.stringify({ browserCookies: { browser: "helium", profilePath: "/tmp/Profile 1" } }) + "\n", "utf8");
	child = runBrowserCookieConfig(home);
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /profilePath is not supported/);
});
