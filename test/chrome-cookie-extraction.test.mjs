import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../chrome-cookies.ts", import.meta.url).href;
const python = process.platform === "win32" ? null : "python3";

function createFixture(home, profile, rows = [], options = {}) {
	if (!python) return;
	const { browser = "Chrome", targetPlatform = process.platform } = options;
	const base = targetPlatform === "darwin"
		? browser === "Brave"
			? join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser")
			: browser === "Helium"
				? join(home, "Library", "Application Support", "net.imput.helium")
				: browser === "Arc"
					? join(home, "Library", "Application Support", "Arc", "User Data")
					: join(home, "Library", "Application Support", "Google", "Chrome")
		: targetPlatform === "win32"
			? browser === "Edge"
				? join(home, "AppData", "Local", "Microsoft", "Edge", "User Data")
				: join(home, "AppData", "Local", "Google", "Chrome", "User Data")
		: join(home, ".config", "google-chrome");
	const dbPath = targetPlatform === "win32" ? join(base, profile, "Network", "Cookies") : join(base, profile, "Cookies");
	mkdirSync(dirname(dbPath), { recursive: true });
	execFileSync(python, ["-c", `
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("create table meta (key text, value integer)")
c.execute("insert into meta values ('version', 24)")
c.execute("create table cookies (name text, value text, host_key text, encrypted_value blob, expires_utc integer)")
for row in json.loads(sys.argv[2]):
    encrypted = bytes.fromhex(row[3][4:]) if isinstance(row[3], str) and row[3].startswith('hex:') else row[3]
    c.execute("insert into cookies values (?, ?, ?, ?, ?)", [row[0], row[1], row[2], encrypted, row[4]])
c.commit()
c.close()
`, dbPath, JSON.stringify(rows)], { stdio: "ignore" });
	if (options.windowsKey) {
		writeFileSync(join(base, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), Buffer.from("protected")]).toString("base64") } }));
	}
}

function encryptWindowsCookie(value, key, version = "v10", hostKey) {
	const nonce = Buffer.alloc(12, 7);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const plaintext = hostKey ? Buffer.concat([createHash("sha256").update(hostKey).digest(), Buffer.from(value)]) : Buffer.from(value);
	return Buffer.concat([Buffer.from(version), nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("hex");
}

function writeWindowsDpapiCommand(bin, argsPath) {
	const script = "#!/bin/sh\n[ -n \"$ARGS_FILE\" ] && printf '%s\\n' \"$@\" > \"$ARGS_FILE\"\nencoded=0\nfor arg do [ \"$arg\" = \"-EncodedCommand\" ] && encoded=1; [ \"$arg\" = \"$DPAPI_PROTECTED\" ] && exit 1; done\n[ \"$encoded\" = 1 ] || exit 1\n[ \"$PIWA_PROTECTED\" = \"$DPAPI_PROTECTED\" ] || exit 1\nprintf '%s' \"$DPAPI_KEY\"\n";
	writeFileSync(join(bin, "powershell.exe"), script);
	chmodSync(join(bin, "powershell.exe"), 0o755);
	return argsPath ? { ARGS_FILE: argsPath } : {};
}

function makeEnvironment(home, bin, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_ALLOW_BROWSER_COOKIES: "1",
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		...extra,
	};
	delete env.PI_CODING_AGENT_DIR;
	delete env.XDG_CONFIG_HOME;
	return env;
}

function writePasswordCommand(bin, countPath, targetPlatform = process.platform, argsPath) {
	const command = targetPlatform === "darwin" ? "security" : "secret-tool";
	const script = `#!/bin/sh\nn=0\n[ -f "$COUNT_FILE" ] && n=$(cat "$COUNT_FILE")\nprintf '%s' $((n + 1)) > "$COUNT_FILE"\n[ -n "$ARGS_FILE" ] && printf '%s\\n' "$@" > "$ARGS_FILE"\nprintf peanuts\n`;
	writeFileSync(join(bin, command), script);
	chmodSync(join(bin, command), 0o755);
	return { COUNT_FILE: countPath, ...(argsPath ? { ARGS_FILE: argsPath } : {}) };
}

function writeFailThenSucceedPasswordCommand(bin, countPath, targetPlatform = process.platform) {
	const command = targetPlatform === "darwin" ? "security" : "secret-tool";
	const script = `#!/bin/sh\nn=0\n[ -f "$COUNT_FILE" ] && n=$(cat "$COUNT_FILE")\nn=$((n + 1))\nprintf '%s' $n > "$COUNT_FILE"\n[ "$n" = 1 ] && exit 1\nprintf peanuts\n`;
	writeFileSync(join(bin, command), script);
	chmodSync(join(bin, command), 0o755);
	return { COUNT_FILE: countPath };
}

function writeFailPasswordCommand(bin, countPath, targetPlatform = process.platform) {
	const command = targetPlatform === "darwin" ? "security" : "secret-tool";
	const script = `#!/bin/sh\nn=0\n[ -f "$COUNT_FILE" ] && n=$(cat "$COUNT_FILE")\nprintf '%s' $((n + 1)) > "$COUNT_FILE"\nprintf 'sensitive stderr' >&2\nexit 1\n`;
	writeFileSync(join(bin, command), script);
	chmodSync(join(bin, command), 0o755);
	return { COUNT_FILE: countPath };
}

function runCookies(home, env, options = "{ requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] }", platformOverride) {
	return runCookieScript(env, `const r = await m.getGoogleCookies(${options}); console.log(JSON.stringify({ result: r, diagnostic: m.getLastGoogleCookieDiagnostic(), details: m.getLastGoogleCookieDiagnosticDetails() }));`, platformOverride);
}

function runCookieScript(env, body, platformOverride) {
	const override = platformOverride
		? `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platformOverride)} }); `
		: "";
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		encoding: "utf8",
		env,
		input: `${override}const m = await import(${JSON.stringify(moduleUrl)}); ${body}`,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function skipWithoutPython(t) {
	if (!python) t.skip("fixture creation requires Python on macOS/Linux");
}

test("cookie extraction remains opt-in even when a browser database exists", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-opt-out-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Default", [["__Secure-1PSID", "one", ".google.com", null, 1]]);
	const env = makeEnvironment(home, bin);
	delete env.PI_ALLOW_BROWSER_COOKIES;
	const result = runCookies(home, env);
	assert.equal(result.result, null);
	assert.match(result.diagnostic, /disabled/);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("auto-discovery finds a non-default Chromium profile", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-profile-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Profile 2", [
		["__Secure-1PSID", "one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "two", ".google.com", null, 2],
	]);
	const env = makeEnvironment(home, bin);
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count")));
	const result = runCookies(home, env);
	assert.deepEqual(result.result.cookies, { "__Secure-1PSIDTS": "two", "__Secure-1PSID": "one" });
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("auto-discovery finds a Brave profile on macOS", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-brave-profile-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Default", [
		["__Secure-1PSID", "one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "two", ".google.com", null, 2],
	], { browser: "Brave", targetPlatform: "darwin" });
	const env = makeEnvironment(home, bin);
	const argsPath = join(home, "password-args");
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count"), "darwin", argsPath));
	const result = runCookies(home, env, undefined, "darwin");
	assert.deepEqual(result.result.cookies, { "__Secure-1PSIDTS": "two", "__Secure-1PSID": "one" });
	assert.deepEqual(readFileSync(argsPath, "utf8").trim().split("\n"), [
		"find-generic-password", "-w", "-a", "Brave", "-s", "Brave Safe Storage",
	]);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("browser selection checks only the requested preset", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-selected-browser-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Profile 1", [
		["__Secure-1PSID", "helium-one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "helium-two", ".google.com", null, 2],
	], { browser: "Helium", targetPlatform: "darwin" });
	createFixture(home, "Profile 1", [
		["__Secure-1PSID", "chrome-one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "chrome-two", ".google.com", null, 2],
	], { browser: "Chrome", targetPlatform: "darwin" });
	const env = makeEnvironment(home, bin);
	const argsPath = join(home, "password-args");
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count"), "darwin", argsPath));
	const result = runCookies(home, env, "{ browser: 'helium', profile: 'Profile 1', requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] }", "darwin");
	assert.deepEqual(result.result.cookies, { "__Secure-1PSIDTS": "helium-two", "__Secure-1PSID": "helium-one" });
	assert.deepEqual(readFileSync(argsPath, "utf8").trim().split("\n"), [
		"find-generic-password", "-w", "-a", "Helium", "-s", "Helium Storage Key",
	]);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("Windows Chrome profiles decrypt v10 cookies with DPAPI keys", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-windows-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	const argsPath = join(home, "powershell-args");
	const key = Buffer.alloc(32, 3);
	createFixture(home, "Default", [
		["__Secure-1PSID", "", ".google.com", `hex:${encryptWindowsCookie("one", key, "v10", ".google.com")}`, 1],
		["__Secure-1PSIDTS", "", ".google.com", `hex:${encryptWindowsCookie("two", key, "v10", ".google.com")}`, 2],
	], { targetPlatform: "win32", windowsKey: key });
	const protectedValue = Buffer.from("protected").toString("base64");
	const env = makeEnvironment(home, bin, { LOCALAPPDATA: join(home, "AppData", "Local"), DPAPI_KEY: key.toString("base64"), DPAPI_PROTECTED: protectedValue, TEMP: tmpdir(), TMP: tmpdir(), ...writeWindowsDpapiCommand(bin, argsPath) });
	const result = runCookies(home, env, undefined, "win32");
	assert.deepEqual(result.result.cookies, { "__Secure-1PSIDTS": "two", "__Secure-1PSID": "one" });
	const args = readFileSync(argsPath, "utf8").trim().split("\n");
	assert.equal(args.includes("-EncodedCommand"), true);
	assert.equal(args.includes(protectedValue), false);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("cookie queries keep high Chromium expiry values safe", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-high-expiry-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Profile 2", [
		["__Secure-1PSID", "expired", ".google.com", null, 1],
		["__Secure-1PSID", "future", ".google.com", null, "9223372036854775807"],
		["__Secure-1PSIDTS", "session", ".google.com", null, 0],
	]);
	const env = makeEnvironment(home, bin);
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count")));
	const result = runCookieScript(env, "const r = await m.getBrowserCookiesForHosts({ hosts: ['www.google.com'], requestUrl: new URL('https://www.google.com/'), requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] }); console.log(JSON.stringify({ result: r, diagnostic: m.getLastBrowserCookieDiagnostic() }));");
	assert.deepEqual(result.result.cookies, { "__Secure-1PSID": "future", "__Secure-1PSIDTS": "session" });
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("cookie expiry filtering preserves same-second validity", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-subsecond-expiry-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	const nowMs = 1_700_000_000_500;
	const sameSecondFutureChromeMicros = (nowMs + 400 + 11644473600000) * 1000;
	createFixture(home, "Profile 2", [
		["__Secure-1PSID", "future", ".google.com", null, sameSecondFutureChromeMicros],
		["__Secure-1PSIDTS", "session", ".google.com", null, 0],
	]);
	const env = makeEnvironment(home, bin);
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count")));
	const result = runCookieScript(env, `Date.now = () => ${nowMs}; const r = await m.getBrowserCookiesForHosts({ hosts: ['www.google.com'], requestUrl: new URL('https://www.google.com/'), requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] }); console.log(JSON.stringify({ result: r, diagnostic: m.getLastBrowserCookieDiagnostic() }));`);
	assert.deepEqual(result.result.cookies, { "__Secure-1PSID": "future", "__Secure-1PSIDTS": "session" });
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("Windows Edge uses the USERPROFILE AppData fallback and reports unsupported v20 cookies", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-windows-edge-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	const key = Buffer.alloc(32, 4);
	createFixture(home, "Default", [
		["__Secure-1PSID", "", ".google.com", `hex:${encryptWindowsCookie("one", key, "v20")}`, 1],
		["__Secure-1PSIDTS", "", ".google.com", `hex:${encryptWindowsCookie("two", key, "v20")}`, 2],
	], { browser: "Edge", targetPlatform: "win32", windowsKey: key });
	const env = makeEnvironment(home, bin, { DPAPI_KEY: key.toString("base64"), DPAPI_PROTECTED: Buffer.from("protected").toString("base64"), TEMP: tmpdir(), TMP: tmpdir() });
	delete env.LOCALAPPDATA;
	writeWindowsDpapiCommand(bin);
	const result = runCookies(home, env, undefined, "win32");
	assert.equal(result.result, null);
	assert.match(result.diagnostic, /v20 app-bound cookies are not supported/);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("required-cookie preflight avoids password invocation for unrelated profiles", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-preflight-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Profile 1", [["NID", "unrelated", ".google.com", null, 1]]);
	const countPath = join(home, "password-count");
	const env = makeEnvironment(home, bin);
	Object.assign(env, writePasswordCommand(bin, countPath));
	const result = runCookies(home, env);
	assert.equal(result.result, null);
	assert.equal(result.diagnostic.includes("required Gemini cookies"), true);
	assert.equal(result.details.attempts.some((attempt) => attempt.browser === "Chrome" && attempt.profile === "Profile 1" && attempt.status === "missing-required-cookies"), true);
	assert.equal(existsSync(countPath), false);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("diagnostics report browser profile when password-store access fails", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-keychain-failure-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Default", [
		["__Secure-1PSID", "one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "two", ".google.com", null, 2],
	], { browser: "Helium", targetPlatform: "darwin" });
	const env = makeEnvironment(home, bin);
	Object.assign(env, writeFailPasswordCommand(bin, join(home, "password-count"), "darwin"));
	const result = runCookies(home, env, undefined, "darwin");
	assert.equal(result.result, null);
	assert.equal(result.diagnostic, "Could not read Helium cookie encryption password");
	assert.deepEqual(result.details.attempts[0], { browser: "Helium", profile: "Default", status: "password-read-failed" });
	assert.doesNotMatch(JSON.stringify(result), /one|two|peanuts|sensitive stderr/);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("diagnostics distinguish required cookie decryption failure", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-decrypt-failure-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	const encrypted = `hex:${Buffer.from("v10bad-ciphertext").toString("hex")}`;
	createFixture(home, "Profile 2", [
		["__Secure-1PSID", "", ".google.com", encrypted, 1],
		["__Secure-1PSIDTS", "", ".google.com", encrypted, 2],
	]);
	const env = makeEnvironment(home, bin);
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count")));
	const result = runCookies(home, env);
	assert.equal(result.result, null);
	assert.match(result.diagnostic, /could not be decrypted/);
	assert.equal(result.details.attempts.some((attempt) => attempt.browser === "Chrome" && attempt.profile === "Profile 2" && attempt.status === "decryption-failed"), true);
	assert.doesNotMatch(JSON.stringify(result), /peanuts|bad-ciphertext/);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("browser encryption password is cached within a process", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-cache-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Profile 2", [
		["__Secure-1PSID", "one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "two", ".google.com", null, 2],
	]);
	const countPath = join(home, "password-count");
	const env = makeEnvironment(home, bin);
	Object.assign(env, writePasswordCommand(bin, countPath));
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		encoding: "utf8",
		env,
		input: `const { getGoogleCookies } = await import(${JSON.stringify(moduleUrl)}); await getGoogleCookies({ profile: 'Profile 2', requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] }); await getGoogleCookies({ profile: 'Profile 2', requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] });`,
	});
	assert.equal(child.status, 0, child.stderr);
	assert.equal(readFileSync(countPath, "utf8"), "1");
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

for (const targetPlatform of ["linux", "darwin"]) {
	test(`failed password lookups are retried instead of cached (${targetPlatform})`, (t) => {
		skipWithoutPython(t);
		const home = mkdtempSync(join(tmpdir(), "pi-cookie-cache-failure-"));
		const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
		try {
			createFixture(home, "Profile 2", [
				["__Secure-1PSID", "one", ".google.com", null, 1],
				["__Secure-1PSIDTS", "two", ".google.com", null, 2],
			], { targetPlatform });
			const countPath = join(home, "password-count");
			const env = makeEnvironment(home, bin);
			Object.assign(env, writeFailThenSucceedPasswordCommand(bin, countPath, targetPlatform));
			const result = runCookieScript(env, `
				const options = { profile: 'Profile 2', requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] };
				const first = await m.getGoogleCookies(options);
				const second = await m.getGoogleCookies(options);
				const third = await m.getGoogleCookies(options);
				console.log(JSON.stringify({ first, second, third }));
			`, targetPlatform);
			const cookies = { "__Secure-1PSIDTS": "two", "__Secure-1PSID": "one" };
			if (targetPlatform === "darwin") {
				assert.equal(result.first, null);
			} else {
				// Linux falls back to its basic-store password. These plaintext
				// fixture cookies remain readable even when secret-tool fails.
				assert.deepEqual(result.first.cookies, cookies);
			}
			assert.deepEqual(result.second.cookies, cookies);
			assert.deepEqual(result.third.cookies, cookies);
			// The failed lookup is retried; the subsequent success is cached.
			assert.equal(readFileSync(countPath, "utf8"), "2");
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(bin, { recursive: true, force: true });
		}
	});
}

test("configured profile names cannot escape the browser profile root", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-profile-traversal-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	const env = makeEnvironment(home, bin);
	const result = runCookies(home, env, "{ profile: '../Profile 2', requiredCookies: ['__Secure-1PSID'] }");
	assert.equal(result.result, null);
	assert.match(result.diagnostic, /profile directory name/);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("explicit profile symlinks cannot escape the browser profile root", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-profile-symlink-"));
	const outsideHome = mkdtempSync(join(tmpdir(), "pi-cookie-outside-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(outsideHome, "Outside", [
		["__Secure-1PSID", "one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "two", ".google.com", null, 2],
	]);
	const browserRoot = process.platform === "darwin"
		? join(home, "Library", "Application Support", "Google", "Chrome")
		: join(home, ".config", "google-chrome");
	const outsideProfile = process.platform === "darwin"
		? join(outsideHome, "Library", "Application Support", "Google", "Chrome", "Outside")
		: join(outsideHome, ".config", "google-chrome", "Outside");
	mkdirSync(browserRoot, { recursive: true });
	symlinkSync(outsideProfile, join(browserRoot, "link"), "dir");
	const env = makeEnvironment(home, bin);
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count")));
	const result = runCookies(home, env, "{ profile: 'link', requiredCookies: ['__Secure-1PSID', '__Secure-1PSIDTS'] }");
	assert.equal(result.result, null);
	assert.match(result.diagnostic, /inside the browser profile root/);
	rmSync(home, { recursive: true, force: true });
	rmSync(outsideHome, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("sqlite3 CLI fallback reads a copied database when node sqlite is unavailable", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-fallback-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Profile 2", [
		["__Secure-1PSID", "one", ".google.com", null, 1],
		["__Secure-1PSIDTS", "two", ".google.com", null, 2],
	]);
	const env = makeEnvironment(home, bin, { PI_WEB_ACCESS_DISABLE_NODE_SQLITE: "1" });
	Object.assign(env, writePasswordCommand(bin, join(home, "password-count")));
	const result = runCookies(home, env);
	assert.deepEqual(result.result.cookies, { "__Secure-1PSIDTS": "two", "__Secure-1PSID": "one" });
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});

test("unavailable SQLite backends produce actionable sanitized diagnostics", (t) => {
	skipWithoutPython(t);
	const home = mkdtempSync(join(tmpdir(), "pi-cookie-diagnostic-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-cookie-bin-"));
	createFixture(home, "Profile 2", [["__Secure-1PSID", "one", ".google.com", null, 1]]);
	const env = makeEnvironment(home, bin, { PI_WEB_ACCESS_DISABLE_NODE_SQLITE: "1", PATH: bin });
	const result = runCookies(home, env);
	assert.equal(result.result, null);
	assert.match(result.diagnostic, /SQLite backend unavailable/);
	assert.equal(result.details.attempts.some((attempt) => attempt.browser === "Chrome" && attempt.profile === "Profile 2" && attempt.status === "sqlite-unavailable"), true);
	assert.equal(result.details.attempts.some((attempt) => attempt.browser === "Chrome" && attempt.profile === "Profile 2" && attempt.status === "missing-required-cookies"), false);
	assert.doesNotMatch(result.diagnostic, /one|peanuts|stderr|password/i);
	rmSync(home, { recursive: true, force: true });
	rmSync(bin, { recursive: true, force: true });
});
