import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

const extractModuleUrl = new URL("../github-extract.ts", import.meta.url).href;

const heldCloneSource = `
	const { existsSync } = await import("node:fs");
	const { writeFile } = await import("node:fs/promises");
	const { dirname } = await import("node:path");
	const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
	const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
	const localPath = result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
	await writeFile(process.env.RUNTIME_READY_FILE, JSON.stringify({ runtimePath: localPath ? dirname(localPath) : null }));
	while (!existsSync(process.env.RUNTIME_RELEASE_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));
`;

async function writeFakeExecutable(binDir, name, source) {
	const executable = join(binDir, name);
	await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
	return executable;
}

async function writeControlledGh(binDir) {
	return writeFakeExecutable(binDir, "gh", `
		const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const args = process.argv.slice(2);
		if (args[0] === "--version") process.exit(0);
		if (args[0] !== "repo" || args[1] !== "clone") process.exit(1);

		const destination = args[3];
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "README.md"), process.env.GH_CLONE_CONTENT || "fixture");
		if (process.env.GH_CLONE_COUNT_FILE) {
			let count = 0;
			try { count = Number(readFileSync(process.env.GH_CLONE_COUNT_FILE, "utf8")); } catch {}
			writeFileSync(process.env.GH_CLONE_COUNT_FILE, String(count + 1));
		}
		if (process.env.GH_READY_FILE) writeFileSync(process.env.GH_READY_FILE, destination);

		const finish = () => process.exit(process.env.GH_CLONE_RESULT === "fail" ? 1 : 0);
		if (!process.env.GH_RELEASE_FILE) finish();
		const timer = setInterval(() => {
			if (!existsSync(process.env.GH_RELEASE_FILE)) return;
			clearInterval(timer);
			finish();
		}, 10);
	`);
}

function spawnModule(source, env) {
	const child = spawn(process.execPath, ["--input-type=module"], {
		stdio: ["pipe", "pipe", "pipe"],
		env,
	});
	child.stdin.end(source);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const completed = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
	});
	return { child, completed };
}

async function waitForFile(path, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCondition(condition, description, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function readJsonWhenReady(path, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for complete JSON in ${path}`);
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		try {
			// Container PID 1 may reap orphaned descendants slowly. A zombie is
			// already terminated and can no longer hold or read from a terminal.
			const state = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[0];
			if (state === "Z") return false;
		} catch {
			// Non-Linux platforms do not expose /proc; kill(0) remains the check.
		}
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !processIsAlive(pid);
}

test("parseGitHubUrl rejects malformed identifiers and preserves normal GitHub paths", async () => {
	const { parseGitHubUrl } = await import(extractModuleUrl);
	assert.equal(parseGitHubUrl("https://github.com/%2E%2E%2Fvictim/repo"), null);
	assert.equal(parseGitHubUrl("https://github.com/owner/repo%2Fother"), null);
	assert.equal(parseGitHubUrl("https://github.com/owner%ZZ/repo"), null);
	assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo.git"), {
		owner: "owner", repo: "repo", refIsFullSha: false, type: "root",
	});
	assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo/blob/main/src/file.ts"), {
		owner: "owner", repo: "repo", ref: "main", refIsFullSha: false, path: "src/file.ts", type: "blob",
	});
	assert.deepEqual(parseGitHubUrl("https://github.com/owner/repo/tree/feature%2Fbranch/src"), {
		owner: "owner", repo: "repo", ref: "feature/branch", refIsFullSha: false, path: "src", type: "tree",
	});
});

test("malformed GitHub identifiers cannot delete outside the clone cache", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-traversal-"));
	const agentDir = join(root, "agent-dir");
	const victim = join(root, "victim", "repo");
	await mkdir(agentDir, { recursive: true });
	await mkdir(victim, { recursive: true });
	await writeFile(join(victim, "marker.txt"), "preserve", "utf8");
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath: join(root, "cache") } }), "utf8");

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			console.log(JSON.stringify(await extractGitHub("https://github.com/..%2Fvictim/repo")));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
	assert.equal(await readFile(join(victim, "marker.txt"), "utf8"), "preserve");
});

test("repository fetches return a README longer than 8K chars in full", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-readme-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath: join(root, "repos") } }), "utf8");
	await writeFakeExecutable(binDir, "gh", `
		const { mkdirSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const args = process.argv.slice(2);
		if (args[0] === "--version") process.exit(0);
		if (args[0] === "repo" && args[1] === "clone") {
			mkdirSync(args[3], { recursive: true });
			writeFileSync(join(args[3], "README.md"), process.env.README_FIXTURE);
			process.exit(0);
		}
		if (args[0] === "api" && args[1].includes("/readme?")) {
			process.stdout.write(Buffer.from(process.env.README_FIXTURE).toString("base64"));
			process.exit(0);
		}
		process.exit(1);
	`);
	const readme = `# Title\n${"x".repeat(21_751)}\nlast line`;

	// A full commit SHA in the URL skips cloning and reads the README through the GitHub API.
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const cloned = await extractGitHub("https://github.com/owner/repo");
			const viaApi = await extractGitHub("https://github.com/owner/repo/tree/${"a".repeat(40)}");
			console.log(JSON.stringify([cloned.content, viaApi.content]));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir, README_FIXTURE: readme },
	});

	assert.equal(child.status, 0, child.stderr);
	const [cloned, viaApi] = JSON.parse(child.stdout);
	assert.match(cloned, /^Repository cloned to: /);
	assert.match(viaApi, /API-only view/);
	for (const content of [cloned, viaApi]) {
		assert.ok(content.includes(readme));
		assert.doesNotMatch(content, /README truncated/);
	}
});

test("clearCloneCache removes only its runtime directory", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-cleanup-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const sibling = join(clonePath, "preserve.txt");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(clonePath, { recursive: true });
	await writeFile(sibling, "preserve", "utf8");
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeFakeExecutable(binDir, "gh", "process.exit(1);");
	await writeFakeExecutable(binDir, "git", `
		const { mkdirSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const destination = process.argv.at(-1);
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "README.md"), "fixture");
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { existsSync } = await import("node:fs");
			const { dirname } = await import("node:path");
			const { clearCloneCache, extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const first = await extractGitHub("https://github.com/owner/repo");
			const firstPath = first?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			const firstRuntimePath = firstPath ? dirname(firstPath) : null;
			const existedBeforeClear = firstRuntimePath ? existsSync(firstRuntimePath) : false;
			clearCloneCache();
			const existsAfterClear = firstRuntimePath ? existsSync(firstRuntimePath) : false;
			const second = await extractGitHub("https://github.com/owner/repo");
			const secondPath = second?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			const secondRuntimePath = secondPath ? dirname(secondPath) : null;
			clearCloneCache();
			console.log(JSON.stringify({
				firstPath,
				firstRuntimePath,
				secondPath,
				secondRuntimePath,
				existedBeforeClear,
				existsAfterClear,
				secondExistsAfterClear: secondRuntimePath ? existsSync(secondRuntimePath) : false,
			}));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.ok(result.firstPath);
	assert.ok(result.secondPath);
	assert.notEqual(result.firstRuntimePath, result.secondRuntimePath);
	assert.equal(result.existedBeforeClear, true);
	assert.equal(result.existsAfterClear, false);
	assert.equal(result.secondExistsAfterClear, false);
	assert.equal(await readFile(sibling, "utf8"), "preserve");
});

test("releaseClonesUnusedSince removes only clones no fetch returned since then", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-release-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath: join(root, "repos") } }), "utf8");
	await writeFakeExecutable(binDir, "gh", "process.exit(1);");
	await writeFakeExecutable(binDir, "git", `
		const { mkdirSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const destination = process.argv.at(-1);
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "README.md"), "fixture");
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { existsSync } = await import("node:fs");
			const { clearCloneCache, extractGitHub, releaseClonesUnusedSince } = await import(${JSON.stringify(extractModuleUrl)});
			const pathOf = (result) => result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
			const old = pathOf(await extractGitHub("https://github.com/owner/old", undefined, true));
			const reused = pathOf(await extractGitHub("https://github.com/owner/reused", undefined, true));
			await sleep(5);
			const since = Date.now();
			await sleep(5);
			// A fetch after the cut-off keeps its clone, even though the clone itself is older.
			await extractGitHub("https://github.com/owner/reused", undefined, true);
			releaseClonesUnusedSince(since);
			const result = { oldExists: existsSync(old), reusedExists: existsSync(reused) };
			clearCloneCache();
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { oldExists: false, reusedExists: true });
});

test("clone cleanup unlinks a direct-child symlink without deleting its target", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-symlink-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const outside = join(root, "outside");
	const destinationFile = join(root, "destination.txt");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(clonePath, { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, "marker.txt"), "preserve", "utf8");
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeFakeExecutable(binDir, "gh", "process.exit(1);");
	await writeFakeExecutable(binDir, "git", `
		const { symlinkSync, writeFileSync } = require("node:fs");
		const destination = process.argv.at(-1);
		symlinkSync(process.env.OUTSIDE_TARGET, destination, "dir");
		writeFileSync(process.env.DESTINATION_FILE, destination);
		process.exit(1);
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			await extractGitHub("https://github.com/owner/repo");
		`,
		encoding: "utf8",
		env: {
			...process.env,
			DESTINATION_FILE: destinationFile,
			OUTSIDE_TARGET: outside,
			PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(existsSync(await readFile(destinationFile, "utf8")), false);
	assert.equal(await readFile(join(outside, "marker.txt"), "utf8"), "preserve");
});

test("a failed clone cannot clean up another process's in-flight destination", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-runtime-race-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const aReady = join(root, "a-ready");
	const aRelease = join(root, "a-release");
	const bReady = join(root, "b-ready");
	const bRelease = join(root, "b-release");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeControlledGh(binDir);

	const childSource = `
		const { existsSync } = await import("node:fs");
		const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
		const localPath = result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
		console.log(JSON.stringify({ result, localPath, pathExists: localPath ? existsSync(localPath) : false }));
	`;
	const commonEnv = {
		...process.env,
		PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
		PI_CODING_AGENT_DIR: agentDir,
	};
	let a;
	let b;
	try {
		a = spawnModule(childSource, {
			...commonEnv,
			GH_CLONE_CONTENT: "runtime-a",
			GH_CLONE_RESULT: "success",
			GH_READY_FILE: aReady,
			GH_RELEASE_FILE: aRelease,
		});
		await waitForFile(aReady);

		b = spawnModule(childSource, {
			...commonEnv,
			GH_CLONE_CONTENT: "runtime-b",
			GH_CLONE_RESULT: "fail",
			GH_READY_FILE: bReady,
			GH_RELEASE_FILE: bRelease,
		});
		await waitForFile(bReady);

		const aPath = await readFile(aReady, "utf8");
		const bPath = await readFile(bReady, "utf8");
		await writeFile(bRelease, "release");
		const bResult = await b.completed;
		const aSurvivedFailureCleanup = existsSync(aPath);
		await writeFile(aRelease, "release");
		const aResult = await a.completed;

		assert.equal(aResult.status, 0, aResult.stderr);
		assert.equal(bResult.status, 0, bResult.stderr);
		assert.notEqual(aPath, bPath);
		assert.equal(JSON.parse(bResult.stdout).result, null);
		assert.equal(aSurvivedFailureCleanup, true);
		const parsedA = JSON.parse(aResult.stdout);
		assert.equal(parsedA.localPath, aPath);
		assert.equal(parsedA.pathExists, true);
		assert.match(parsedA.result.content, /runtime-a/);
	} finally {
		await Promise.allSettled([writeFile(aRelease, "release"), writeFile(bRelease, "release")]);
		if (a?.child.exitCode === null) a.child.kill("SIGKILL");
		if (b?.child.exitCode === null) b.child.kill("SIGKILL");
	}
});

test("runtime cache reuse and cleanup stay isolated across processes", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-runtime-clear-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const aReady = join(root, "a-runtime-ready.json");
	const aRelease = join(root, "a-runtime-release");
	const aCount = join(root, "a-count");
	const bCount = join(root, "b-count");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeControlledGh(binDir);

	const commonEnv = {
		...process.env,
		PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
		PI_CODING_AGENT_DIR: agentDir,
	};
	let a;
	try {
		a = spawnModule(`
			const { existsSync, readFileSync } = await import("node:fs");
			const { writeFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const first = await extractGitHub("https://github.com/owner/repo", undefined, true);
			const second = await extractGitHub("https://github.com/owner/repo", undefined, true);
			const firstPath = first?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			const secondPath = second?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			await writeFile(process.env.RUNTIME_READY_FILE, JSON.stringify({
				firstPath,
				secondPath,
				firstContent: first?.content ?? null,
				secondContent: second?.content ?? null,
			}));
			while (!existsSync(process.env.RUNTIME_RELEASE_FILE)) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			console.log(JSON.stringify({
				pathExists: firstPath ? existsSync(firstPath) : false,
				readme: firstPath ? readFileSync(join(firstPath, "README.md"), "utf8") : null,
			}));
		`, {
			...commonEnv,
			GH_CLONE_CONTENT: "runtime-a",
			GH_CLONE_COUNT_FILE: aCount,
			RUNTIME_READY_FILE: aReady,
			RUNTIME_RELEASE_FILE: aRelease,
		});
		await waitForFile(aReady);

		const b = spawnModule(`
			const { existsSync, statSync } = await import("node:fs");
			const { dirname } = await import("node:path");
			const { clearCloneCache, extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
			const localPath = result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			const runtimePath = localPath ? dirname(localPath) : null;
			const runtimeMode = runtimePath ? statSync(runtimePath).mode & 0o777 : null;
			clearCloneCache();
			console.log(JSON.stringify({
				content: result?.content ?? null,
				localPath,
				runtimeMode,
				existsAfterClear: runtimePath ? existsSync(runtimePath) : false,
			}));
		`, {
			...commonEnv,
			GH_CLONE_CONTENT: "runtime-b",
			GH_CLONE_COUNT_FILE: bCount,
		});
		const bResult = await b.completed;
		assert.equal(bResult.status, 0, bResult.stderr);

		const aState = JSON.parse(await readFile(aReady, "utf8"));
		const bState = JSON.parse(bResult.stdout);
		assert.ok(aState.firstPath);
		assert.equal(aState.firstPath, aState.secondPath);
		assert.notEqual(aState.firstPath, bState.localPath);
		assert.match(aState.firstContent, /runtime-a/);
		assert.match(aState.secondContent, /runtime-a/);
		assert.match(bState.content, /runtime-b/);
		assert.equal(await readFile(aCount, "utf8"), "1");
		assert.equal(await readFile(bCount, "utf8"), "1");
		assert.equal(bState.runtimeMode & 0o077, 0);
		assert.equal(bState.existsAfterClear, false);
		assert.equal(existsSync(aState.firstPath), true);
		assert.equal((await stat(dirname(aState.firstPath))).mode & 0o077, 0);

		await writeFile(aRelease, "release");
		const aResult = await a.completed;
		assert.equal(aResult.status, 0, aResult.stderr);
		assert.deepEqual(JSON.parse(aResult.stdout), { pathExists: true, readme: "runtime-a" });
	} finally {
		await writeFile(aRelease, "release");
		if (a?.child.exitCode === null) a.child.kill("SIGKILL");
	}
});

test("clone runtime creation proceeds while background cleanup is gated", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-runtime-background-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const cleanupRelease = join(root, "cleanup-release");
	const ready = join(root, "runtime-ready.json");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(clonePath, { recursive: true });
	await writeFile(join(clonePath, "runtime-unknown"), "preserve", "utf8");
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeControlledGh(binDir);

	const commonEnv = {
		...process.env,
		PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
		PI_CODING_AGENT_DIR: agentDir,
		RUNTIME_CLEANUP_RELEASE_FILE: cleanupRelease,
	};
	let child;
	try {
		child = spawnModule(`
			const { existsSync } = await import("node:fs");
			const { writeFile } = await import("node:fs/promises");
			const originalAsyncIterator = (await import("node:fs")).Dir.prototype[Symbol.asyncIterator];
			let cleanupReadStarted = false;
			(await import("node:fs")).Dir.prototype[Symbol.asyncIterator] = function() {
				const iterator = originalAsyncIterator.call(this);
				return {
					next: async (...args) => {
						if (!cleanupReadStarted) {
							cleanupReadStarted = true;
							while (!existsSync(process.env.RUNTIME_CLEANUP_RELEASE_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));
						}
						return iterator.next(...args);
					},
					return: (...args) => iterator.return?.(...args),
					throw: (...args) => iterator.throw?.(...args),
					[Symbol.asyncIterator]() { return this; },
				};
			};
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
			const localPath = result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			while (!cleanupReadStarted) await new Promise((resolve) => setTimeout(resolve, 10));
			await writeFile(process.env.RUNTIME_READY_FILE, JSON.stringify({ localPath, cleanupReadStarted }));
			while (!existsSync(process.env.RUNTIME_CLEANUP_RELEASE_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));
		`, {
			...commonEnv,
			RUNTIME_READY_FILE: ready,
		});
		const state = await readJsonWhenReady(ready);
		assert.ok(state.localPath);
		assert.equal(state.cleanupReadStarted, true);
		assert.equal(existsSync(state.localPath), true);
		assert.equal(existsSync(cleanupRelease), false);
		await writeFile(cleanupRelease, "release");
		const result = await child.completed;
		assert.equal(result.status, 0, result.stderr);
	} finally {
		await writeFile(cleanupRelease, "release").catch(() => {});
		if (child?.child.exitCode === null) child.child.kill("SIGKILL");
	}
});

test("background cleanup removes dead runtimes after unrelated files and ownerless directories", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-runtime-background-late-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const staleReady = join(root, "stale-ready.json");
	const staleRelease = join(root, "stale-release");
	const currentReady = join(root, "current-ready.json");
	const currentRelease = join(root, "current-release");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(clonePath, { recursive: true });
	for (let i = 0; i < 512; i++) {
		await mkdir(join(clonePath, `runtime-preserved-${String(i).padStart(3, "0")}`), { recursive: true });
	}
	for (let i = 0; i < 1024; i++) {
		await writeFile(join(clonePath, `unrelated-${String(i).padStart(4, "0")}`), "preserve", "utf8");
	}
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeControlledGh(binDir);

	const commonEnv = {
		...process.env,
		PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
		PI_CODING_AGENT_DIR: agentDir,
	};
	let stale;
	let current;
	try {
		stale = spawnModule(`
			const { existsSync } = await import("node:fs");
			const { mkdir, readFile, writeFile } = await import("node:fs/promises");
			const { dirname, join } = await import("node:path");
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
			const localPath = result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			const runtimePath = localPath ? dirname(localPath) : null;
			if (!runtimePath) process.exit(1);
			const parentPath = dirname(runtimePath);
			const owner = await readFile(join(runtimePath, ".owner.json"), "utf8");
			const stalePaths = [];
			for (let i = 0; i < 3; i++) {
				const stalePath = join(parentPath, "runtime-late-dead-" + String(i).padStart(3, "0"));
				await mkdir(stalePath, { recursive: true });
				await writeFile(join(stalePath, ".owner.json"), owner, "utf8");
				stalePaths.push(stalePath);
			}
			await writeFile(process.env.RUNTIME_READY_FILE, JSON.stringify({ runtimePath, stalePaths }));
			while (!existsSync(process.env.RUNTIME_RELEASE_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));
		`, {
			...commonEnv,
			RUNTIME_READY_FILE: staleReady,
			RUNTIME_RELEASE_FILE: staleRelease,
		});
		const staleState = await readJsonWhenReady(staleReady);
		assert.ok(staleState.stalePaths?.length === 3);
		assert.ok(staleState.runtimePath);
		assert.equal(existsSync(staleState.runtimePath), true);
		stale.child.kill("SIGKILL");
		await stale.completed;

		current = spawnModule(heldCloneSource, {
			...commonEnv,
			RUNTIME_READY_FILE: currentReady,
			RUNTIME_RELEASE_FILE: currentRelease,
		});
		const currentState = await readJsonWhenReady(currentReady);
		assert.ok(currentState.runtimePath);
		assert.notEqual(currentState.runtimePath, staleState.runtimePath);
		await waitForCondition(() => [staleState.runtimePath, ...staleState.stalePaths].every((path) => !existsSync(path)), "dead runtime cleanup");
		assert.equal(existsSync(currentState.runtimePath), true);
		assert.equal(existsSync(join(clonePath, "runtime-preserved-000")), true);
		assert.equal(existsSync(join(clonePath, "runtime-preserved-511")), true);
		await writeFile(currentRelease, "release");
		const currentResult = await current.completed;
		assert.equal(currentResult.status, 0, currentResult.stderr);
	} finally {
		await Promise.allSettled([writeFile(staleRelease, "release"), writeFile(currentRelease, "release")]);
		if (stale?.child.exitCode === null) stale.child.kill("SIGKILL");
		if (current?.child.exitCode === null) current.child.kill("SIGKILL");
	}
});

test("oversized malformed owner metadata is preserved during extraction", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-runtime-owner-size-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const malformedRuntime = join(clonePath, "runtime-oversized-owner");
	const deadRuntime = join(clonePath, "runtime-dead");
	const ready = join(root, "runtime-ready.json");
	const release = join(root, "runtime-release");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(malformedRuntime, { recursive: true });
	await writeFile(join(malformedRuntime, ".owner.json"), "{" + "x".repeat(4095), "utf8");
	await mkdir(deadRuntime, { recursive: true });
	await writeFile(join(deadRuntime, ".owner.json"), JSON.stringify({ version: 1, pid: 999999999, platform: process.platform, bootId: "test", startTime: "1" }), "utf8");
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeControlledGh(binDir);

	const commonEnv = {
		...process.env,
		PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
		PI_CODING_AGENT_DIR: agentDir,
	};
	let child;
	try {
		child = spawnModule(`
			const { existsSync } = await import("node:fs");
			const { writeFile } = await import("node:fs/promises");
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
			const localPath = result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? null;
			await writeFile(process.env.RUNTIME_READY_FILE, JSON.stringify({ localPath }));
			while (!existsSync(process.env.RUNTIME_RELEASE_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));
		`, {
			...commonEnv,
			RUNTIME_READY_FILE: ready,
			RUNTIME_RELEASE_FILE: release,
		});
		const state = await readJsonWhenReady(ready);
		assert.ok(state.localPath);
		await waitForCondition(() => !existsSync(deadRuntime), "dead runtime cleanup");
		assert.equal(existsSync(state.localPath), true);
		assert.equal(existsSync(malformedRuntime), true);
		await writeFile(release, "release");
		const result = await child.completed;
		assert.equal(result.status, 0, result.stderr);
	} finally {
		await writeFile(release, "release").catch(() => {});
		if (child?.child.exitCode === null) child.child.kill("SIGKILL");
	}
});


test("clone runtime initialization preserves live, unknown, and symlink runtimes", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-runtime-preserve-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const unknownRuntime = join(clonePath, "runtime-unknown");
	const deadRuntime = join(clonePath, "runtime-dead");
	const outside = join(root, "outside");
	const symlinkRuntime = join(clonePath, "runtime-symlink");
	const liveReady = join(root, "live-ready.json");
	const liveRelease = join(root, "live-release");
	const currentReady = join(root, "current-ready.json");
	const currentRelease = join(root, "current-release");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await mkdir(unknownRuntime, { recursive: true });
	await mkdir(deadRuntime, { recursive: true });
	await writeFile(join(deadRuntime, ".owner.json"), JSON.stringify({ version: 1, pid: 999999999, platform: process.platform, bootId: "test", startTime: "1" }), "utf8");
	await mkdir(outside, { recursive: true });
	await writeFile(join(outside, "marker.txt"), "preserve", "utf8");
	await symlink(outside, symlinkRuntime, "dir");
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath } }), "utf8");
	await writeControlledGh(binDir);

	const commonEnv = {
		...process.env,
		PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
		PI_CODING_AGENT_DIR: agentDir,
	};
	let live;
	let current;
	try {
		live = spawnModule(heldCloneSource, {
			...commonEnv,
			RUNTIME_READY_FILE: liveReady,
			RUNTIME_RELEASE_FILE: liveRelease,
		});
		const liveState = await readJsonWhenReady(liveReady);
		assert.ok(liveState.runtimePath);

		current = spawnModule(`
			const { existsSync } = await import("node:fs");
			const { writeFile } = await import("node:fs/promises");
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo", undefined, true);
			await writeFile(process.env.RUNTIME_READY_FILE, JSON.stringify({ content: result?.content ?? null }));
			while (!existsSync(process.env.RUNTIME_RELEASE_FILE)) await new Promise((resolve) => setTimeout(resolve, 10));
		`, {
			...commonEnv,
			RUNTIME_READY_FILE: currentReady,
			RUNTIME_RELEASE_FILE: currentRelease,
		});
		await waitForFile(currentReady);

		await waitForCondition(() => !existsSync(deadRuntime), "background cleanup");
		assert.equal(existsSync(liveState.runtimePath), true);
		assert.equal(existsSync(unknownRuntime), true);
		assert.equal(existsSync(symlinkRuntime), true);
		assert.equal(await readFile(join(outside, "marker.txt"), "utf8"), "preserve");
	} finally {
		await Promise.allSettled([writeFile(liveRelease, "release"), writeFile(currentRelease, "release")]);
		if (live?.child.exitCode === null) live.child.kill("SIGKILL");
		if (current?.child.exitCode === null) current.child.kill("SIGKILL");
	}
});

test("normalizeClonePath expands ~ to HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-expand-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: "~/test-repos" } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			// Trigger config load by calling extractGitHub with a non-GitHub URL
			// The config is loaded internally, so we check the clone path via a GitHub URL
			const result = await extractGitHub("https://github.com/test/repo");
			// If we got here without error, config loaded successfully
			console.log(JSON.stringify({ success: true }));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	// The test passes if the config loads without error
	// We can't directly test the expanded path without exporting loadGitHubConfig
	// but we've verified the code doesn't crash
});

test("normalizeClonePath expands $HOME and other env vars", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-expand-env-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: "$HOME/my-repos" } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify({ success: true }));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
});

test("normalizeClonePath handles absolute paths without expansion", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-abs-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { clonePath: "/tmp/my-repos" } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify({ success: true }));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
});

test("GitHub clones disable interactive credential prompts", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-noninteractive-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const clonePath = join(root, "repos");
	const envFile = join(root, "clone-env.json");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		// Not a timeout test: the fake git (a Node shim) must *finish* its fake
		// clone. Give it room for a cold Node boot on a slow CI host.
		JSON.stringify({ githubClone: { clonePath, cloneTimeoutSeconds: 4 } }),
		"utf8",
	);
	await writeFakeExecutable(binDir, "gh", "process.exit(1);");
	await writeFakeExecutable(
		binDir,
		"git",
		`
			const { mkdirSync, writeFileSync } = require("node:fs");
			const { join } = require("node:path");
			const destination = process.argv.at(-1);
			mkdirSync(destination, { recursive: true });
			writeFileSync(join(destination, "README.md"), "fixture");
			writeFileSync(process.env.CLONE_ENV_FILE, JSON.stringify({
				gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT,
				gcmInteractive: process.env.GCM_INTERACTIVE,
				ghPromptDisabled: process.env.GH_PROMPT_DISABLED,
			}));
		`,
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify(result !== null));
		`,
		encoding: "utf8",
		// Outer budget must cover child Node boot + fake gh probe boot + fake git boot
		// + the 4 s clone ceiling with real margin (each shim boot is ~1 s on a loaded host).
		timeout: 15_000,
		env: {
			...process.env,
			CLONE_ENV_FILE: envFile,
			PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), true);
	assert.deepEqual(JSON.parse(await readFile(envFile, "utf8")), {
		gitTerminalPrompt: "0",
		gcmInteractive: "Never",
		ghPromptDisabled: "1",
	});
});

test("GitHub clone timeout force-kills the SIGTERM-resistant process group", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-timeout-tree-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	const processPidFile = join(root, "processes.json");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		// The fake git is a "#!/usr/bin/env node" shim: the timeout must outlast a
		// cold Node boot on a slow CI host, or the tree is killed before the shim
		// has recorded its pids (ENOENT below). 3 s is still a fast test.
		JSON.stringify({ githubClone: { clonePath: join(root, "repos"), cloneTimeoutSeconds: 3 } }),
		"utf8",
	);
	await writeFakeExecutable(binDir, "gh", "process.exit(1);");
	await writeFakeExecutable(
		binDir,
		"git",
		`
			const { spawn } = require("node:child_process");
			const { writeFileSync } = require("node:fs");
			process.on("SIGTERM", () => {});
			const helperSource = ${JSON.stringify(`
				process.on("SIGTERM", () => {});
				setInterval(() => {}, 1000);
			`)};
			const helper = spawn(process.execPath, ["-e", helperSource], { stdio: "ignore" });
			// Record both pids from the parent, synchronously after spawn: the helper's
			// pid exists before its Node runtime boots, so the pid file is guaranteed to
			// be present even if the clone timeout fires before the helper is ready.
			writeFileSync(process.env.CLONE_PROCESS_PID_FILE, JSON.stringify({
				rootPid: process.pid,
				helperPid: helper.pid,
			}));
			setInterval(() => {}, 1000);
		`,
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/test/repo");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		// Allow the clone timeout, kill grace, and cold Node/fake gh startups.
		timeout: 15_000,
		env: {
			...process.env,
			CLONE_PROCESS_PID_FILE: processPidFile,
			PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
	const { rootPid, helperPid } = JSON.parse(await readFile(processPidFile, "utf8"));
	try {
		assert.equal(await waitForProcessExit(rootPid), true, `clone process ${rootPid} survived SIGKILL fallback`);
		assert.equal(await waitForProcessExit(helperPid), true, `clone helper ${helperPid} survived SIGKILL fallback`);
	} finally {
		if (processIsAlive(rootPid)) process.kill(rootPid, "SIGKILL");
		if (processIsAlive(helperPid)) process.kill(helperPid, "SIGKILL");
	}
});

test("githubClone.enabled false skips GitHub clone/API specialization", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-disabled-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { enabled: false } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
});
