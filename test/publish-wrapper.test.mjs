import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const publishScript = fileURLToPath(new URL("../scripts/publish.js", import.meta.url));
// Only a hang guard: these tests finish in about a second, but spawning node
// child processes on a loaded CI runner or during the full suite has taken over 5s.
const WAIT_TIMEOUT_MS = 30_000;

async function withTimeout(promise, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), WAIT_TIMEOUT_MS);
				timer.unref();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function waitForClose(child) {
	return withTimeout(
		new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		}),
		"publish wrapper timed out",
	);
}

async function createFixture(mode) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-publish-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module", pi: { extensions: ["./index.ts"] } }, null, 2)}\n`);

	const fakeNpm = join(bin, "fake-npm.mjs");
	await writeFile(fakeNpm, `#!/usr/bin/env node
import { access, readFile, watch, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const signalFile = join(root, "terminated");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    writeFileSync(signalFile, JSON.stringify({ signal, pid: process.pid }));
    process.exit(0);
  });
}
const manifestPath = join(root, "package.json");
const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
pkg.pi.extensions = ["./dist"];
await writeFile(manifestPath, JSON.stringify(pkg, null, 2) + "\\n");
await writeFile(join(root, "args"), JSON.stringify(process.argv.slice(2)));
console.log(process.pid);
const continuePath = join(root, "continue");
const watcher = watch(root);
try {
  try {
    await access(continuePath);
  } catch {
	for await (const event of watcher) {
	  if (event.filename === "continue") break;
	}
  }
} finally {
  await watcher.return();
}
process.exit(Number(process.env.FAKE_NPM_EXIT));
`);
	await chmod(fakeNpm, 0o755);

	if (process.platform === "win32") {
		await writeFile(join(bin, "npm.cmd"), `@"${process.execPath}" "%~dp0\\fake-npm.mjs" %*\r\n`);
	} else {
		await cp(fakeNpm, join(bin, "npm"));
		await chmod(join(bin, "npm"), 0o755);
	}

	return { root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FAKE_NPM_EXIT: String(mode) } };
}

async function runScenario({ exitCode, signal }) {
	const fixture = await createFixture(exitCode);
	let child;
	let fakePid;
	try {
		const before = JSON.parse(await readFile(join(fixture.root, "package.json"), "utf8"));
		assert.deepEqual(before.pi.extensions, ["./index.ts"]);

		child = spawn(process.execPath, [publishScript, "--tag", "next"], {
			cwd: fixture.root,
			env: fixture.env,
			stdio: ["ignore", "pipe", "ignore"],
		});

		const lines = createInterface({ input: child.stdout });
		const [ready] = await withTimeout(once(lines, "line"), "fake npm did not become ready");
		lines.close();
		fakePid = Number(ready);
		const during = JSON.parse(await readFile(join(fixture.root, "package.json"), "utf8"));
		assert.deepEqual(during.pi.extensions, ["./dist"]);
		assert.deepEqual(JSON.parse(await readFile(join(fixture.root, "args"), "utf8")), ["publish", "--tag", "next"]);

		if (signal) child.kill(signal);
		else await writeFile(join(fixture.root, "continue"), "go");

		const result = await waitForClose(child);
		assert.equal(result.code, signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : exitCode);
		const after = JSON.parse(await readFile(join(fixture.root, "package.json"), "utf8"));
		assert.deepEqual(after.pi.extensions, ["./index.ts"]);

		if (signal) {
			const terminated = JSON.parse(await readFile(join(fixture.root, "terminated"), "utf8"));
			assert.equal(terminated.signal, signal);
			assert.equal(terminated.pid, fakePid);
		}
	} finally {
		if (child?.exitCode === null && child?.signalCode === null) {
			child.kill("SIGKILL");
			if (fakePid) try { process.kill(fakePid, "SIGKILL"); } catch {}
		}
		await rm(fixture.root, { recursive: true, force: true });
	}
}

test("publish wrapper restores the manifest after npm succeeds", () => runScenario({ exitCode: 0 }));
test("publish wrapper restores the manifest and preserves npm failure status", () => runScenario({ exitCode: 7 }));
test("publish wrapper restores the manifest and exits 1 when npm cannot spawn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-publish-spawn-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(root, "package.json"), `${JSON.stringify({ type: "module", pi: { extensions: ["./dist"] } }, null, 2)}\n`);
	let child;
	try {
		child = spawn(process.execPath, [publishScript], {
			cwd: root,
			env: { ...process.env, PATH: bin },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const result = await waitForClose(child);
		assert.equal(result.code, 1);
		assert.match(stderr, /could not start npm publish/);
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
	} finally {
		if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});
test("publish wrapper forwards SIGINT to npm, waits, and restores", { skip: process.platform === "win32" }, () => runScenario({ exitCode: 0, signal: "SIGINT" }));
test("publish wrapper forwards SIGTERM to npm, waits, and restores", { skip: process.platform === "win32" }, () => runScenario({ exitCode: 0, signal: "SIGTERM" }));
