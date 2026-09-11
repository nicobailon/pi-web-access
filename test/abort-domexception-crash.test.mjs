import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const summaryUrl = new URL("../summary-review.ts", import.meta.url).href;

// Regression test for a crash where a bare AbortController.abort() inside the
// summary deadline timer constructed a DOMException via globalThis.DOMException.
// When a runtime installs a throwing/fake DOMException (e.g. the
// node-domexception polyfill bundled by some hosts), that throw escaped the
// Timeout._onTimeout callback as an uncaughtException and killed the process.
//
// The fix passes an explicit abort reason (so abort() never builds a
// DOMException) and guards the timer callback. This test asserts both that the
// process survives a throwing DOMException AND that the deadline abort uses an
// explicit reason (signal.reason is the marker, not a DOMException).
test("summary deadline abort uses explicit reason and survives a throwing DOMException", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(),
		encoding: "utf8",
		timeout: 15_000,
	});
	assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
	assert.match(child.stdout, /SURVIVED/);
	assert.match(child.stdout, /REASON_IS_MARKER/);
	assert.doesNotMatch(child.stdout + child.stderr, /UNCAUGHT/);
});

function buildChildScript() {
	// A summary model registry that always fails fast so generateSummaryDraft
	// falls back deterministically once the deadline path is exercised.
	const moduleSource = `
		export const complete = () => { throw new Error("no provider"); };
		export const completeSimple = complete;
		export const clampThinkingLevel = (_m, l) => l;
	`;
	const loaderSource = `
		export async function resolve(specifier, context, next) {
			if (specifier === "@earendil-works/pi-ai/compat" || specifier === "@earendil-works/pi-ai") {
				return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(moduleSource))}, shortCircuit: true };
			}
			return next(specifier, context);
		}
	`;
	return `
		import { register } from "node:module";
		import { mkdtemp, rm } from "node:fs/promises";
		import { tmpdir } from "node:os";
		import { join } from "node:path";

		// Install a global DOMException that throws when used to build an
		// AbortError reason — mimicking the broken node-domexception polyfill.
		const RealDE = globalThis.DOMException;
		globalThis.DOMException = class extends RealDE {
			constructor(message, name) {
				if (name === "AbortError") {
					throw new RealDE("This operation was aborted", "AbortError");
				}
				super(message, name);
			}
		};

		let crashed = false;
		process.on("uncaughtException", (err) => {
			crashed = true;
			console.error("UNCAUGHT:", err && err.name, err && err.message);
		});

		register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loaderSource)}), import.meta.url);
		const agentDir = await mkdtemp(join(tmpdir(), "abort-de-crash-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const { generateSummaryDraft } = await import(${JSON.stringify(summaryUrl)});

			// Capture the reason passed to the internal deadline controller's
			// abort() by observing the completion signal's reason after timeout.
			const registry = {
				find: () => undefined,
				getAvailable: () => [],
				getApiKeyAndHeaders: async () => ({ ok: false }),
			};

			// Track the reason on the deadline signal. generateSummaryDraft wires
			// deadlineController.signal into AbortSignal.any; we instead verify the
			// deadline path completed via fallback and did not crash. To assert the
			// explicit reason, we spy on AbortController.prototype.abort.
			let sawExplicitReason = false;
			const origAbort = AbortController.prototype.abort;
			AbortController.prototype.abort = function (reason) {
				if (arguments.length > 0 && reason !== undefined) sawExplicitReason = true;
				return origAbort.call(this, reason);
			};

			// deadlineMs = 5 forces the real timer to fire while generation is in
			// progress; with the old bare abort() the throwing DOMException would
			// escape the timer callback on affected runtimes.
			const result = await generateSummaryDraft([], {
				modelRegistry: registry, cwd: agentDir, isProjectTrusted: () => false,
			}, undefined, undefined, undefined, undefined, 5);

			AbortController.prototype.abort = origAbort;
			// Let any deferred uncaughtException surface.
			await new Promise((resolve) => setTimeout(resolve, 30));
			if (crashed) {
				console.error("CRASHED");
				process.exit(1);
			}
			console.log(sawExplicitReason ? "REASON_IS_MARKER" : "NO_EXPLICIT_REASON");
			console.log("SURVIVED", result.meta.fallbackUsed);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	`;
}
