import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);

const extractorUrl = new URL("../pdf-extract.ts", import.meta.url).href;

test("extractPDFToMarkdown works on Node 22 without native Promise.try", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF extraction failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);

	assert.match(child.stdout, /Hello PDF/);
});

test("extractPDFToMarkdown uses Gemini before loading unpdf", () => {
	const loaderDir = mkdtempSync(
		join(tmpdir(), "pi-web-access-pdf-gemini-first-"),
	);
	const loaderPath = join(loaderDir, "block-unpdf-loader.mjs");
	writeFileSync(loaderPath, buildBlockUnpdfLoader());

	try {
		const child = spawnSync(
			process.execPath,
			["--experimental-loader", loaderPath, "--input-type=module"],
			{
				input: buildChildScript(extractorUrl, false, "success"),
				encoding: "utf8",
				maxBuffer: 2 * 1024 * 1024,
			},
		);

		assert.equal(
			child.status,
			0,
			"PDF Gemini-first assertion failed in a child process. stderr summary:\n" +
				errorSummary(child.stderr),
		);
		assert.match(child.stdout, /Gemini PDF/);
	} finally {
		rmSync(loaderDir, { recursive: true, force: true });
	}
});

test("extractPDFToMarkdown falls back to unpdf when Gemini output is truncated", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "truncate"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF Gemini fallback failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Hello PDF/);
});

test("extractPDFToMarkdown preserves caller cancellation without local fallback", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "abort"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF cancellation assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Aborted/);
	assert.doesNotMatch(child.stdout, /Hello PDF/);
});

test("extractPDFToMarkdown passes PDF.js errors-only verbosity", () => {
	const loaderDir = mkdtempSync(join(tmpdir(), "pi-web-access-pdf-loader-"));
	const loaderPath = join(loaderDir, "unpdf-loader.mjs");
	writeFileSync(loaderPath, buildUnpdfLoader());

	try {
		const child = spawnSync(
			process.execPath,
			["--experimental-loader", loaderPath, "--input-type=module"],
			{
				input: buildChildScript(extractorUrl, true),
				encoding: "utf8",
				maxBuffer: 2 * 1024 * 1024,
			},
		);

		assert.equal(
			child.status,
			0,
			"PDF verbosity assertion failed in a child process. stderr summary:\n" +
				errorSummary(child.stderr),
		);

		const options = JSON.parse(child.stdout.trim().split("\n").at(-1));
		assert.equal(options.verbosity, 0);
	} finally {
		rmSync(loaderDir, { recursive: true, force: true });
	}
});

function buildBlockUnpdfLoader() {
	return `
    export function resolve(specifier, context, nextResolve) {
      if (specifier === "unpdf" || specifier === "unpdf/pdfjs") {
        throw new Error("unpdf should not load before successful Gemini PDF extraction");
      }
      return nextResolve(specifier, context);
    }
  `;
}

function buildUnpdfLoader() {
	const unpdfUrl = pathToFileURL(require.resolve("unpdf")).href;
	return `
    const unpdfUrl = ${JSON.stringify(unpdfUrl)};

    export function resolve(specifier, context, nextResolve) {
      if (specifier === "unpdf") {
        return { url: "pi-web-access:test-unpdf", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }

    export async function load(url, context, nextLoad) {
      if (url === "pi-web-access:test-unpdf") {
        return {
          format: "module",
          shortCircuit: true,
          source:
            "import * as unpdf from " + JSON.stringify(unpdfUrl) + ";" +
            "export const getDocumentProxy = (...args) => {" +
            "  globalThis.__piWebAccessUnpdfOptions = args[1];" +
            "  return unpdf.getDocumentProxy(...args);" +
            "};",
        };
      }
      return nextLoad(url, context);
    }
  `;
}

function buildChildScript(
	moduleUrl,
	printOptions = false,
	geminiMode = "none",
	datalabMode = "none",
	provider = null,
) {
	return `
        import { mkdtemp, readFile, writeFile } from "node:fs/promises";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
    
        process.on("uncaughtException", (error) => {
          console.error(error?.stack || error);
          process.exit(1);
        });
        process.on("unhandledRejection", (error) => {
          console.error(error?.stack || error);
          process.exit(1);
        });
    
        Reflect.deleteProperty(Promise, "try");
        if (typeof Promise.try !== "undefined") {
          throw new Error("Expected Promise.try to be unavailable before PDF extraction");
        }
    
        const geminiMode = ${JSON.stringify(geminiMode)};
        const datalabMode = ${JSON.stringify(datalabMode)};
        const provider = ${JSON.stringify(provider)};
        const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-pdf-config-"));
        process.env.PI_CODING_AGENT_DIR = configDir;
    
        if (provider) {
          await writeFile(
            join(configDir, "web-search.json"),
            JSON.stringify({ pdf: { provider } }),
          );
        }
    
        if (geminiMode !== "none") {
          process.env.GEMINI_API_KEY = "synthetic-gemini-key";
        } else {
          delete process.env.GEMINI_API_KEY;
          delete process.env.GOOGLE_GEMINI_BASE_URL;
          delete process.env.CLOUDFLARE_API_KEY;
        }
    
        if (datalabMode !== "none") {
          process.env.DATALAB_API_KEY = "synthetic-datalab-key";
        } else {
          delete process.env.DATALAB_API_KEY;
        }
    
        if (geminiMode !== "none" || datalabMode !== "none") {
          globalThis.fetch = async (url, init) => {
            if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const urlString = String(url);
            if (urlString.includes("generateContent")) {
              if (provider === "datalab" || provider === "unpdf") {
                throw new Error("Gemini called but provider=" + provider);
              }
              if (geminiMode === "success" || geminiMode === "truncate") {
                const success = geminiMode === "success";
                return new Response(JSON.stringify({
                  candidates: [{
                    finishReason: success ? "STOP" : "MAX_TOKENS",
                    content: { parts: [{ text: success ? "<!-- Page 1 -->\\nGemini PDF" : "<!-- Page 1 -->\\nPartial" }] },
                  }],
                }), { status: 200, headers: { "content-type": "application/json" } });
              }
            }
            if (datalabMode !== "none") {
              if (urlString.includes("/files/upload")) {
                return new Response(JSON.stringify({
                  file_id: 7,
                  upload_url: "https://storage.test/put/abc",
                  reference: "datalab://file-7",
                }), { status: 200, headers: { "content-type": "application/json" } });
              }
              if (urlString.includes("/put/")) {
                return new Response(null, { status: 200 });
              }
              if (urlString.includes("/files/7/confirm")) {
                return new Response(JSON.stringify({
                  file_id: 7,
                  reference: "datalab://file-7",
                  message: "confirmed",
                }), { status: 200, headers: { "content-type": "application/json" } });
              }
              if (urlString.endsWith("/files/7")) {
                return new Response(null, { status: 200 });
              }
            }
            if (urlString.includes("/convert") || urlString.includes("/check")) {
              if (datalabMode === "fail") {
                return new Response(JSON.stringify({ detail: "boom" }), {
                  status: 500,
                  statusText: "Internal Server Error",
                  headers: { "content-type": "application/json" },
                });
              }
              if (urlString.includes("/convert")) {
                return new Response(JSON.stringify({
                  status: "processing",
                  request_check_url: "/check/1",
                }), { status: 200, headers: { "content-type": "application/json" } });
              }
              return new Response(JSON.stringify({
                status: "complete",
                success: true,
                markdown: "<!-- Page 1 -->\\nDatalab PDF",
                page_count: 1,
              }), { status: 200, headers: { "content-type": "application/json" } });
            }
            throw new Error("unexpected fetch: " + urlString);
          };
        }
    
        const { extractPDFToMarkdown } = await import(${JSON.stringify(moduleUrl)});
        const outputDir = await mkdtemp(join(tmpdir(), "pi-web-access-pdf-"));

    if (geminiMode === "abort") {
      const controller = new AbortController();
      controller.abort();
      let preservedCancellation = false;
      try {
        await extractPDFToMarkdown(
          makePdf("Hello PDF"),
          "https://example.test/hello.pdf",
          { outputDir, signal: controller.signal },
        );
      } catch (error) {
        preservedCancellation = /abort/i.test(error instanceof Error ? error.message : String(error));
        if (!preservedCancellation) throw error;
      }
      if (!preservedCancellation) throw new Error("Expected PDF extraction to preserve cancellation");
      console.log("Aborted");
    } else {
      const result = await extractPDFToMarkdown(
        makePdf("Hello PDF"),
        "https://example.test/hello.pdf",
        { outputDir },
      );

      console.log(await readFile(result.outputPath, "utf8"));
      ${printOptions ? "console.log(JSON.stringify(globalThis.__piWebAccessUnpdfOptions));" : ""}
    }

    function makePdf(text) {
      const content = "BT /F1 24 Tf 72 720 Td (" + text + ") Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Length " + Buffer.byteLength(content, "ascii") + " >>\\nstream\\n" + content + "\\nendstream",
      ];
      let body = "%PDF-1.4\\n";
      const offsets = [0];

      for (let index = 0; index < objects.length; index += 1) {
        offsets.push(Buffer.byteLength(body, "ascii"));
        body += String(index + 1) + " 0 obj\\n" + objects[index] + "\\nendobj\\n";
      }

      const xrefOffset = Buffer.byteLength(body, "ascii");
      body += "xref\\n0 " + String(objects.length + 1) + "\\n";
      body += "0000000000 65535 f \\n";

      for (const offset of offsets.slice(1)) {
        body += String(offset).padStart(10, "0") + " 00000 n \\n";
      }

      body += "trailer\\n<< /Size " + String(objects.length + 1) + " /Root 1 0 R >>\\n";
      body += "startxref\\n" + String(xrefOffset) + "\\n%%EOF\\n";

      return new TextEncoder().encode(body).buffer;
    }
  `;
}

test("extractPDFToMarkdown uses Datalab before unpdf when configured", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "none", "success"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF Datalab-first assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Datalab PDF/);
});

test("extractPDFToMarkdown falls back to unpdf when Datalab conversion fails", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "none", "fail"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF Datalab fallback failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Hello PDF/);
});

test("extractPDFToMarkdown auto order runs Datalab before Gemini", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "success", "success"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF Datalab-before-Gemini assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Datalab PDF/);
	assert.doesNotMatch(child.stdout, /Gemini PDF/);
});

test("extractPDFToMarkdown auto order falls back from Datalab to Gemini", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "success", "fail"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF Datalab-to-Gemini fallback assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Gemini PDF/);
	assert.doesNotMatch(child.stdout, /Datalab PDF/);
});

test("extractPDFToMarkdown provider=datalab skips Gemini even with a Gemini key", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(
			extractorUrl,
			false,
			"success",
			"success",
			"datalab",
		),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF provider=datalab assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Datalab PDF/);
	assert.doesNotMatch(child.stdout, /Gemini PDF/);
});

test("extractPDFToMarkdown provider=datalab without a key skips Gemini", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "success", "none", "datalab"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF provider=datalab without key assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Hello PDF/);
	assert.doesNotMatch(child.stdout, /Gemini PDF/);
});

test("extractPDFToMarkdown provider=gemini skips Datalab even with a Datalab key", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(
			extractorUrl,
			false,
			"success",
			"success",
			"gemini",
		),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF provider=gemini assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Gemini PDF/);
	assert.doesNotMatch(child.stdout, /Datalab PDF/);
});

test("extractPDFToMarkdown provider=unpdf skips Gemini even with a Gemini key", () => {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, false, "success", "none", "unpdf"),
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(
		child.status,
		0,
		"PDF provider=unpdf assertion failed in a child process. stderr summary:\n" +
			errorSummary(child.stderr),
	);
	assert.match(child.stdout, /Hello PDF/);
	assert.doesNotMatch(child.stdout, /Gemini PDF/);
});

function errorSummary(value, size = 1200) {
	const marker = "TypeError: Promise.try is not a function";
	const index = value.indexOf(marker);
	if (index >= 0) {
		return value.slice(index, index + size);
	}

	return value.length > size ? value.slice(-size) : value;
}
