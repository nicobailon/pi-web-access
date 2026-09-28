import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const authFetchUrl = new URL("../auth-fetch.ts", import.meta.url).href;
const extractUrl = new URL("../extract.ts", import.meta.url).href;
const python = process.platform === "win32" ? null : "python3";

function createCookieFixture(home, rows) {
	if (!python) return;
	const profileDir = process.platform === "darwin"
		? join(home, "Library", "Application Support", "Google", "Chrome", "Default")
		: join(home, ".config", "google-chrome", "Default");
	const dbPath = join(profileDir, "Cookies");
	mkdirSync(profileDir, { recursive: true });
	execFileSync(python, ["-c", `
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("create table meta (key text, value integer)")
c.execute("insert into meta values ('version', 24)")
c.execute("create table cookies (name text, value text, host_key text, path text, encrypted_value blob, expires_utc integer, top_frame_site_key text)")
for row in json.loads(sys.argv[2]):
    c.execute("insert into cookies values (?, ?, ?, ?, ?, ?, ?)", row)
c.commit()
c.close()
`, dbPath, JSON.stringify(rows)]);
}

function writePasswordCommand(bin) {
	const command = process.platform === "darwin" ? "security" : "secret-tool";
	writeFileSync(join(bin, command), "#!/bin/sh\nprintf peanuts\n");
	chmodSync(join(bin, command), 0o755);
}

function runModule(root, script, extraEnv = {}) {
	const env = {
		...process.env,
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: root,
		PI_ALLOW_BROWSER_COOKIES: "1",
		...extraEnv,
	};
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: script,
		encoding: "utf8",
		env,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("authFetch profiles resolve named, single true, and host policy", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-auth-fetch-policy-"));
	try {
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ authFetch: { social: ["x.com"], work: { hosts: ["docs.company.com"], cache: "off" } } }) + "\n");
		const output = runModule(root, `
			const { resolveAuthFetchProfile, assertAuthFetchUrl } = await import(${JSON.stringify(authFetchUrl)});
			const work = resolveAuthFetchProfile("work");
			let trueError = "";
			try { resolveAuthFetchProfile(true); } catch (err) { trueError = err instanceof Error ? err.message : String(err); }
			let insecureError = "";
			try { assertAuthFetchUrl(work, "http://docs.company.com/private"); } catch (err) { insecureError = err instanceof Error ? err.message : String(err); }
			let disallowedError = "";
			try { assertAuthFetchUrl(work, "https://evil.example/private"); } catch (err) { disallowedError = err instanceof Error ? err.message : String(err); }
			const allowed = assertAuthFetchUrl(work, "https://sub.docs.company.com/private").hostname;
			console.log(JSON.stringify({ work, trueError, insecureError, disallowedError, allowed }));
		`);
		assert.equal(output.work.cache, "off");
		assert.match(output.trueError, /exactly one/);
		assert.match(output.insecureError, /HTTPS/);
		assert.match(output.disallowedError, /not allowed/);
		assert.equal(output.allowed, "sub.docs.company.com");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("authFetch true selects the only profile", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-auth-fetch-single-"));
	try {
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ authFetch: { work: ["example.com"] } }) + "\n");
		const output = runModule(root, `
			const { resolveAuthFetchProfile } = await import(${JSON.stringify(authFetchUrl)});
			console.log(JSON.stringify(resolveAuthFetchProfile(true)));
		`);
		assert.equal(output.name, "work");
		assert.deepEqual(output.hosts, ["example.com"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("authenticated fetch sends only browser-scoped cookies with raw values", (t) => {
	if (!python) t.skip("fixture creation requires Python on macOS/Linux");
	const root = mkdtempSync(join(tmpdir(), "pi-auth-fetch-cookie-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-auth-fetch-bin-"));
	try {
		writePasswordCommand(bin);
		createCookieFixture(root, [
			["parentDomain", "parent=a=b/%", ".example.com", "/", null, "20000000000000000", ""],
			["targetHost", "host=a=b/%", "app.example.com", "/", null, "20000000000000000", ""],
			["targetDomain", "domain=a=b/%", ".app.example.com", "/private", null, "20000000000000000", ""],
			["sid", "root", ".app.example.com", "/", null, "20000000000000000", ""],
			["sid", "private=a=b/%", ".app.example.com", "/private", null, "20000000000000000", ""],
			["sessionCookie", "session", ".app.example.com", "/private", null, 0, ""],
			["expired", "expired", ".app.example.com", "/private", null, 1, ""],
			["wrongPath", "settings", ".app.example.com", "/settings", null, "20000000000000000", ""],
			["parentHostOnly", "parent-host", "example.com", "/", null, "20000000000000000", ""],
			["siblingDomain", "sibling", ".other.example.com", "/", null, "20000000000000000", ""],
			["childDomain", "child", ".child.app.example.com", "/", null, "20000000000000000", ""],
			["partitioned", "partitioned", ".app.example.com", "/private", null, "20000000000000000", "https://other.example"],
		]);
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ authFetch: { work: ["example.com"] } }) + "\n");
		const output = runModule(root, `
			const calls = [];
			globalThis.fetch = async (url, init = {}) => {
				calls.push({ url: String(url), cookie: init.headers?.cookie ?? null, redirect: init.redirect });
				return new Response("private body", { status: 200, headers: { "content-type": "text/plain" } });
			};
			const { resolveAuthFetchProfile } = await import(${JSON.stringify(authFetchUrl)});
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://app.example.com/private/page", undefined, { mode: "raw", authFetchProfile: resolveAuthFetchProfile("work"), lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`, { PATH: `${bin}:${process.env.PATH ?? ""}` });
		assert.equal(output.calls.length, 1);
		assert.equal(output.calls[0].url, "https://app.example.com/private/page");
		assert.equal(output.calls[0].redirect, "manual");
		assert.match(output.calls[0].cookie, /parentDomain=parent=a=b\/%/);
		assert.match(output.calls[0].cookie, /targetHost=host=a=b\/%/);
		assert.match(output.calls[0].cookie, /targetDomain=domain=a=b\/%/);
		assert.match(output.calls[0].cookie, /sessionCookie=session/);
		assert.ok(output.calls[0].cookie.indexOf("sid=private=a=b/%") < output.calls[0].cookie.indexOf("sid=root"));
		assert.doesNotMatch(output.calls[0].cookie, /expired=expired/);
		assert.doesNotMatch(output.calls[0].cookie, /wrongPath=settings/);
		assert.doesNotMatch(output.calls[0].cookie, /parentHostOnly=parent-host/);
		assert.doesNotMatch(output.calls[0].cookie, /siblingDomain=sibling/);
		assert.doesNotMatch(output.calls[0].cookie, /childDomain=child/);
		assert.doesNotMatch(output.calls[0].cookie, /partitioned=partitioned/);
		assert.equal(output.result.content, "private body");
		assert.equal(output.result.error, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("authenticated same-origin redirects recompute path-scoped cookies", (t) => {
	if (!python) t.skip("fixture creation requires Python on macOS/Linux");
	const root = mkdtempSync(join(tmpdir(), "pi-auth-fetch-redirect-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-auth-fetch-bin-"));
	try {
		writePasswordCommand(bin);
		createCookieFixture(root, [
			["start", "start", ".example.com", "/start", null, "20000000000000000", ""],
			["next", "next", ".example.com", "/next", null, "20000000000000000", ""],
		]);
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ authFetch: { work: ["example.com"] } }) + "\n");
		const output = runModule(root, `
			const calls = [];
			globalThis.fetch = async (url, init = {}) => {
				calls.push({ url: String(url), cookie: init.headers?.cookie ?? null, redirect: init.redirect });
				if (String(url) === "https://app.example.com/start/page") {
					return new Response("", { status: 302, headers: { location: "/next/page" } });
				}
				return new Response("redirected body", { status: 200, headers: { "content-type": "text/plain" } });
			};
			const { resolveAuthFetchProfile } = await import(${JSON.stringify(authFetchUrl)});
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://app.example.com/start/page", undefined, { mode: "raw", authFetchProfile: resolveAuthFetchProfile("work"), lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`, { PATH: `${bin}:${process.env.PATH ?? ""}` });
		assert.equal(output.calls.length, 2);
		assert.equal(output.calls[0].url, "https://app.example.com/start/page");
		assert.match(output.calls[0].cookie, /start=start/);
		assert.doesNotMatch(output.calls[0].cookie, /next=next/);
		assert.equal(output.calls[1].url, "https://app.example.com/next/page");
		assert.match(output.calls[1].cookie, /next=next/);
		assert.doesNotMatch(output.calls[1].cookie, /start=start/);
		assert.equal(output.result.content, "redirected body");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("authenticated fetch failure does not fall through to hosted providers", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-auth-fetch-no-fallback-"));
	try {
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ authFetch: { work: ["example.com"] }, fetchRouting: { providers: ["http", "jina"], allowRemoteHostedProviders: true } }) + "\n");
		const output = runModule(root, `
			const calls = [];
			globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("hosted", { status: 200 }); };
			const { resolveAuthFetchProfile } = await import(${JSON.stringify(authFetchUrl)});
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://example.com/private", undefined, { authFetchProfile: resolveAuthFetchProfile("work"), lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`);
		assert.deepEqual(output.calls, []);
		assert.match(output.result.error, /could not read browser cookies|No detected Chromium profile/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("authenticated Cloudflare challenge stays direct-only", (t) => {
	if (!python) t.skip("fixture creation requires Python on macOS/Linux");
	const root = mkdtempSync(join(tmpdir(), "pi-auth-fetch-challenge-"));
	const bin = mkdtempSync(join(tmpdir(), "pi-auth-fetch-bin-"));
	try {
		writePasswordCommand(bin);
		createCookieFixture(root, [["sid", "session", ".example.com", "/", null, "20000000000000000", ""]]);
		writeFileSync(join(root, "web-search.json"), JSON.stringify({ authFetch: { work: ["example.com"] }, fetchRouting: { providers: ["http", "jina"], allowRemoteHostedProviders: true } }) + "\n");
		const output = runModule(root, `
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response("<html><head><title>Just a moment...</title></head><body></body></html>", { status: 200, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } });
			};
			const { resolveAuthFetchProfile } = await import(${JSON.stringify(authFetchUrl)});
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const result = await extractContent("https://app.example.com/private", undefined, { authFetchProfile: resolveAuthFetchProfile("work"), lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
			console.log(JSON.stringify({ calls, result }));
		`, { PATH: `${bin}:${process.env.PATH ?? ""}` });
		assert.deepEqual(output.calls, ["https://app.example.com/private"]);
		assert.match(output.result.error, /^HTTP 200: Blocked by Cloudflare challenge page/);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});
