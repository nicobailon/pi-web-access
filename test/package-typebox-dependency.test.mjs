import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

test("packed installs keep typebox as a peer dependency (hosted by pi at runtime)", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-pack-install-"));
	try {
		const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", tempDir], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const [{ filename, files }] = JSON.parse(packOutput);
		const packedFiles = files.map((file) => file.path);
		assert.ok(packedFiles.includes("index.ts"));
		assert.ok(packedFiles.includes("CHANGELOG.md"));
		assert.ok(packedFiles.includes("SECURITY.md"));
		assert.ok(!packedFiles.some((path) => path.startsWith("skills/")));
		assert.ok(!packedFiles.some((path) => path.startsWith("test/")));
	const tarball = join(tempDir, filename);

	// With peer dependencies auto-installed, the packed package resolves
	// typebox through node_modules/typebox and leaves no private copy in
	// its own dependencies, matching pi's host-provided-modules contract.
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
		cwd: tempDir,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const packageRequire = createRequire(join(tempDir, "node_modules", "pi-web-access", "package.json"));
	const installedManifest = packageRequire("pi-web-access/package.json");
	assert.equal(installedManifest.peerDependencies?.typebox, "*");
	assert.equal(installedManifest.dependencies?.typebox, undefined);
	assert.match(packageRequire.resolve("typebox").replaceAll("\\", "/"), /node_modules\/*typebox\//);

	// Installing with peers omitted (pi-managed installs run npm with
	// --legacy-peer-deps semantics) yields no local copy at all; pi hosts
	// typebox at runtime. Use a separate sibling tree so Node's parent-dir
	// resolution above this tree cannot pick up the first install's copy.
	const noPeersTempDir = join(tmpdir(), "pi-web-access-pack-nopeers-" + process.pid + "-" + Date.now());
	try {
		mkdirSync(noPeersTempDir, { recursive: true });
		execFileSync("npm", ["install", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
			cwd: noPeersTempDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const noPeerRequire = createRequire(join(noPeersTempDir, "node_modules", "pi-web-access", "package.json"));
		assert.throws(
			() => noPeerRequire.resolve("typebox"),
			(err) => err.code === "MODULE_NOT_FOUND" && err.message.includes("typebox"),
		);
	} finally {
		await rm(noPeersTempDir, { recursive: true, force: true });
	}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
