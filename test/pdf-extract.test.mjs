import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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
    "PDF extraction failed in a child process. stderr summary:\n" + errorSummary(child.stderr),
  );

  assert.match(child.stdout, /Hello PDF/);
});

function buildChildScript(moduleUrl) {
  return `
    import { mkdtemp, readFile } from "node:fs/promises";
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

    const { extractPDFToMarkdown } = await import(${JSON.stringify(moduleUrl)});

    const outputDir = await mkdtemp(join(tmpdir(), "pi-web-access-pdf-"));
    const result = await extractPDFToMarkdown(
      makePdf("Hello PDF"),
      "https://example.test/hello.pdf",
      { outputDir },
    );

    console.log(await readFile(result.outputPath, "utf8"));

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

function errorSummary(value, size = 1200) {
  const marker = "TypeError: Promise.try is not a function";
  const index = value.indexOf(marker);
  if (index >= 0) {
    return value.slice(index, index + size);
  }

  return value.length > size ? value.slice(-size) : value;
}
