import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
for (const scenario of ["import-timer", "import-elapsed", "html-processing", "image-processing", "caller-abort"]) {
	test(`direct extraction rejects late success: ${scenario}`, () => {
		const loader = `
			export async function resolve(s, c, next) {
				if (s === "linkedom") {
					const real = await next(s, c);
					const source = 'export * from ' + JSON.stringify(real.url) + '; globalThis.importStarted(); await globalThis.importGate;';
					return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
				}
				if (s === "turndown") {
					const real = await next(s, c);
					const source = 'import Real from ' + JSON.stringify(real.url) + '; export default class extends Real { turndown(html) { const result = super.turndown(html); globalThis.processing(); return result; } }';
					return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
				}
				if (s === "@earendil-works/pi-coding-agent") {
					return { url: "data:text/javascript," + encodeURIComponent('export async function resizeImage() { globalThis.processing(); return { width: 1, height: 1, data: "AA==", mimeType: "image/png" }; }'), shortCircuit: true };
				}
				return next(s, c);
			}
		`;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			encoding: "utf8", timeout: 10_000,
			input: `
				import assert from "node:assert/strict";
				import { register } from "node:module";
				import { mock } from "node:test";
				import { mkdtemp, writeFile, rm } from "node:fs/promises";
				import { tmpdir } from "node:os";
				import { join } from "node:path";
				register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
				const root = await mkdtemp(join(tmpdir(), "extract-cold-deadline-"));
				process.env.PI_CODING_AGENT_DIR = root;
				await writeFile(join(root, "web-search.json"), JSON.stringify({ fetch: { timeout: 0.1 }, fetchRouting: { providers: ["http"] } }));
				const scenario = ${JSON.stringify(scenario)};
				const image = scenario === "image-processing" || scenario === "caller-abort";
				globalThis.fetch = async () => new Response(image ? "image" : '<html><head><title>Article</title></head><body><article><h1>Article</h1><p>' + 'A useful article with enough readable text for successful extraction. '.repeat(30) + '</p></article></body></html>', { headers: { "content-type": image ? "image/png" : "text/html" } });
				const { extractContent } = await import(${JSON.stringify(extractUrl)});
				const started = new Promise(resolve => { globalThis.importStarted = resolve; });
				let release;
				globalThis.importGate = new Promise(resolve => { release = resolve; });
				const controller = new AbortController();
				globalThis.processing = () => {
					if (scenario.endsWith("processing") || scenario === "caller-abort") mock.timers.setTime(101);
					if (scenario === "caller-abort") controller.abort();
				};
				mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
				try {
					const pending = extractContent("https://example.com/article", controller.signal, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
					if (!image) {
						await started;
						if (scenario === "import-timer") mock.timers.tick(100);
						if (scenario === "import-elapsed") mock.timers.setTime(101);
						release();
					}
					const result = await pending;
					if (scenario === "caller-abort") assert.equal(result.error, "Aborted");
					else assert.ok(result.error?.startsWith("The operation was aborted."), JSON.stringify(result));
					assert.equal(result.content, "");
					assert.equal(result.thumbnail, undefined);
				} finally {
					mock.timers.reset();
					await rm(root, { recursive: true, force: true });
				}
			`,
		});
		assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
	});
}
