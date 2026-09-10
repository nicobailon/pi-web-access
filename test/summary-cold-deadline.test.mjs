import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const summaryUrl = new URL("../summary-review.ts", import.meta.url).href;

test("pre-aborted summary rejects without creating an unhandled abort contender", async () => {
	const { generateSummaryDraft } = await import(summaryUrl);
	await assert.rejects(generateSummaryDraft([], { modelRegistry: {} }, AbortSignal.abort()), /Aborted/);
	// Let node:test observe any rejected contender left behind after the public rejection.
	await new Promise(resolve => setImmediate(resolve));
});

for (const mode of ["compat", "thinking"]) {
	for (const scenario of ["pending-import", "expired-import", "expired-completion", "expired-throw", "expired-rejection", "caller-abort"]) {
		test(`summary ${mode}: ${scenario} respects cancellation on cold first use`, () => {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				input: buildChildScript(mode, scenario),
				encoding: "utf8",
				timeout: 10_000,
			});
			assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
		});
	}
}

function buildChildScript(mode, scenario) {
	const specifier = mode === "compat" ? "@earendil-works/pi-ai/compat" : "@earendil-works/pi-ai";
	const moduleSource = `
		globalThis.importStarted();
		await globalThis.importGate;
		export const complete = (...args) => globalThis.testComplete(...args);
		export const completeSimple = complete;
		export const clampThinkingLevel = (_model, level) => level;
	`;
	const loaderSource = `
		export async function resolve(specifier, context, next) {
			if (specifier === ${JSON.stringify(specifier)}) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(moduleSource))}, shortCircuit: true };
			return next(specifier, context);
		}
	`;
	return `
		import assert from "node:assert/strict";
		import { mkdtemp, rm } from "node:fs/promises";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { register } from "node:module";
		import { mock } from "node:test";

		register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loaderSource)}), import.meta.url);
		const agentDir = await mkdtemp(join(tmpdir(), "summary-cold-deadline-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { generateSummaryDraft } = await import(${JSON.stringify(summaryUrl)});
		const scenario = ${JSON.stringify(scenario)};
		const importStarted = new Promise(resolve => { globalThis.importStarted = resolve; });
		let releaseImport;
		globalThis.importGate = new Promise(resolve => { releaseImport = resolve; });
		let calls = 0;
		globalThis.testComplete = (_model, _context, options) => {
			calls++;
			assert.equal(options.signal.aborted, false, "must not invoke an expired provider");
			const failAfterExpiry = () => {
				mock.timers.setTime(101);
				throw new Error("late provider failure");
			};
			if (scenario === "expired-throw") failAfterExpiry();
			if (scenario === "expired-rejection") return Promise.resolve().then(failAfterExpiry);
			if (scenario === "expired-completion") mock.timers.setTime(101);
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Late answer" }] });
		};
		const model = { provider: "test", id: "model", reasoning: true };
		const registry = {
			find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			...(${JSON.stringify(mode)} === "thinking" ? { complete: globalThis.testComplete } : {}),
		};
		const controller = new AbortController();
		mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
		try {
			const pending = generateSummaryDraft([], {
				modelRegistry: registry, cwd: agentDir, isProjectTrusted: () => false,
			}, controller.signal, "test/model" + (${JSON.stringify(mode)} === "thinking" ? ":high" : ""), undefined, undefined, 100);
			// Wait for cold module evaluation before advancing the clock.
			await importStarted;
			if (scenario === "caller-abort") {
				controller.abort();
				await assert.rejects(pending, /Aborted/);
			} else {
				if (scenario === "pending-import") {
					mock.timers.tick(100);
					// The module is still gated: timeout must settle without waiting for its import.
				} else {
					if (scenario === "expired-import") mock.timers.setTime(101);
					releaseImport();
				}
				const result = await pending;
				assert.equal(result.meta.fallbackUsed, true);
				assert.equal(result.meta.fallbackReason, "summary-generation-timeout");
				assert.ok(result.meta.durationMs >= 100);
				assert.notEqual(result.summary, "Late answer");
			}
			releaseImport();
			await import(${JSON.stringify(specifier)});
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(calls, ["expired-completion", "expired-throw", "expired-rejection"].includes(scenario) ? 1 : 0, "cold import must not start completion after cancellation");
		} finally {
			mock.timers.reset();
			await rm(agentDir, { recursive: true, force: true });
		}
	`;
}
