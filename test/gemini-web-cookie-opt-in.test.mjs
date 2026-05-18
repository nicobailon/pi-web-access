import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../browser-config.ts", import.meta.url).href;

function runBrowserStealthCheck(home, extraEnv = {}) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;
	Object.assign(env, extraEnv);

	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `const { isBrowserStealthAvailable } = await import(${JSON.stringify(moduleUrl)}); console.log(String(isBrowserStealthAvailable()));`,
		encoding: "utf8",
		env,
	});
}

test("browser stealth is disabled unless explicitly allowed", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-stealth-opt-in-"));

	let child = runBrowserStealthCheck(home);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify({ browserStealthEnabled: true }) + "\n", "utf8");

	child = runBrowserStealthCheck(home);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const envHome = await mkdtemp(join(tmpdir(), "pi-web-access-stealth-env-"));
	child = runBrowserStealthCheck(envHome, { PI_ALLOW_BROWSER_COOKIES: "1" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});
