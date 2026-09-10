import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const kind of ["page", "rewrite"]) {
	for (const outcome of ["resolve", "reject"]) {
		test(`${kind} cancels before cold compat import ${outcome}s without late completion`, () => {
			const moduleUrl = new URL(kind === "page" ? "../page-query.ts" : "../query-rewrite.ts", import.meta.url).href;
			const source = `
				globalThis.importStarted();
				await globalThis.importGate;
				export function complete() { globalThis.calls++; return { content: [{ text: "late" }] }; }
			`;
			const loader = `export async function resolve(s, c, next) {
				if (s === "@earendil-works/pi-ai/compat") return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(source))}, shortCircuit: true };
				return next(s, c);
			}`;
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8", timeout: 10_000,
				input: `
					import assert from "node:assert/strict";
					import { register } from "node:module";
					import { mkdtemp, rm } from "node:fs/promises";
					import { tmpdir } from "node:os";
					import { join } from "node:path";
					register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
					const root = await mkdtemp(join(tmpdir(), "query-cold-abort-"));
					process.env.PI_CODING_AGENT_DIR = root;
					try {
						const api = await import(${JSON.stringify(moduleUrl)});
						const started = new Promise(resolve => { globalThis.importStarted = resolve; });
						let release, reject;
						globalThis.importGate = new Promise((yes, no) => { release = yes; reject = no; });
						globalThis.calls = 0;
						const model = { provider: "anthropic", id: "claude-haiku-4-5", input: ["text"], contextWindow: 10000 };
						const ctx = { model, cwd: root, isProjectTrusted: () => false, modelRegistry: {
							find: () => model, getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
						} };
						const controller = new AbortController();
						const pending = ${JSON.stringify(kind)} === "page"
							? api.answerFromPage({ question: "Q", pageText: "P", sourceUrl: "https://example.com" }, ctx, controller.signal)
							: api.rewriteSearchQuery("Q", ctx, controller.signal);
						const rejected = assert.rejects(pending, /^Error: Aborted$/);
						await started;
						controller.abort();
						// Import remains gated until the public operation acknowledges cancellation.
						await rejected;
						if (${JSON.stringify(outcome)} === "reject") reject(new Error("late import failure"));
						else release();
						await import("@earendil-works/pi-ai/compat").catch(() => {});
						await new Promise(resolve => setImmediate(resolve));
						assert.equal(globalThis.calls, 0);
					} finally { await rm(root, { recursive: true, force: true }); }
				`,
			});
			assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
		});
	}
}
