#!/usr/bin/env node
// pi-web-access-mcp: serves the web tools over MCP stdio. stdout carries only
// JSON-RPC, so every diagnostic goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "./package.json" with { type: "json" };
import { createMcpServer } from "./mcp-server.ts";
import { createStandaloneWebToolCore } from "./web-tool-core.ts";

// Keep stray console output from dependencies off the JSON-RPC stream.
console.log = console.info = console.debug = console.error;

const core = createStandaloneWebToolCore();
const server = createMcpServer(core, { name: "pi-web-access", version: pkg.version }, core.enabledToolNames);
const transport = new StdioServerTransport();

let closing = false;
async function shutdown(code: number): Promise<void> {
	if (closing) return;
	closing = true;
	try {
		// Closing aborts in-flight tool calls through their request signals.
		await server.close();
	} catch (error) {
		console.error("pi-web-access-mcp: error during shutdown:", error);
	}
	process.exit(code);
}

process.stdin.once("end", () => void shutdown(0));
process.stdin.once("close", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
	await server.connect(transport);
} catch (error) {
	console.error("pi-web-access-mcp: failed to start:", error);
	process.exit(1);
}
