#!/usr/bin/env node
// Builds the dist/ bundles with externals derived from package.json.
//
// Declared dependencies and peerDependencies stay external: they resolve from
// node_modules at runtime, and the running pi host provides @earendil-works/*
// as jiti virtual modules. Deriving the list keeps future dependencies
// external automatically instead of silently bundling them into dist.
// node:* builtins are covered by --platform=node.
//
// The standalone MCP bin (dist/mcp-cli.js) bundles typebox: it stays a
// pi-hosted peer for the extension, but the bin must run without pi or peers.
import { chmodSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const externals = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  "@earendil-works/*",
];

const esbuildCmd = process.platform === "win32" ? "esbuild.cmd" : "esbuild";

function bundle(entry, external) {
  const args = [
    entry,
    "--bundle",
    "--format=esm",
    "--platform=node",
    "--target=node20",
    "--outdir=dist",
    "--outbase=.",
    ...external.map((name) => `--external:${name}`),
  ];
  const result = spawnSync(esbuildCmd, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

bundle("index.ts", externals);
bundle("mcp-cli.ts", externals.filter((name) => name !== "typebox"));
chmodSync("dist/mcp-cli.js", 0o755);
