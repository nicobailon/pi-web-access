import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const fixturePath = join(__dirname, "fixtures", "hello.pdf");
const tsxBin = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

async function withTempRunner<T>(prefix: string, build: (workDir: string, runnerPath: string) => Promise<T>): Promise<T> {
  const workDir = await mkdtemp(join(tmpdir(), prefix));
  const runnerPath = join(workDir, "runner.mjs");

  try {
    return await build(workDir, runnerPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

test("repository keeps the modern unpdf line and adds a dedicated Promise.try shim", async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const installedUnpdf = JSON.parse(
    await readFile(join(projectRoot, "node_modules", "unpdf", "package.json"), "utf8"),
  ) as { version?: string };

  assert.equal(packageJson.dependencies?.unpdf, "^1.4.0");
  assert.equal(packageJson.dependencies?.["promise.try"], "^2.0.1");
  assert.notEqual(installedUnpdf.version, "1.4.0");
});

test("unpdf 1.6.0 reproduces the Promise.try crash on runtimes without Promise.try", async (t) => {
  if (typeof Promise.try === "function") {
    t.skip("runtime already supports Promise.try");
    return;
  }

  await withTempRunner("pi-web-access-unpdf-repro-", async (workDir, runnerPath) => {
    execFileSync("npm", ["pack", "--silent", "unpdf@1.6.0"], { cwd: workDir, stdio: "pipe" });
    execFileSync("tar", ["-xzf", "unpdf-1.6.0.tgz"], { cwd: workDir, stdio: "pipe" });

    await writeFile(
      runnerPath,
      `import { readFileSync } from "node:fs";
import { getDocumentProxy } from ${JSON.stringify(join(workDir, "package", "dist", "index.mjs"))};
const bytes = readFileSync(${JSON.stringify(fixturePath)});
const arr = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const pdf = await getDocumentProxy(arr);
const page = await pdf.getPage(1);
const text = await page.getTextContent();
console.log(text.items.map(item => item.str).join(" "));
`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [runnerPath], {
      cwd: workDir,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0, `expected failure, got stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /Promise\.try is not a function/);
  });
});

test("extractPDFToMarkdown succeeds on the same runtime via the compatibility shim", async () => {
  await withTempRunner("pi-web-access-pdf-success-", async (_workDir, runnerPath) => {
    await writeFile(
      runnerPath,
      `import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractPDFToMarkdown } from ${JSON.stringify(join(projectRoot, "pdf-extract.ts"))};
const pdfBuffer = await readFile(${JSON.stringify(fixturePath)});
const outputDir = await mkdtemp(join(tmpdir(), "pi-web-access-pdf-output-"));
try {
  const arrayBuffer = pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength);
  const result = await extractPDFToMarkdown(arrayBuffer, "https://example.com/hello.pdf", { outputDir });
  const markdown = await readFile(result.outputPath, "utf8");
  assert.equal(result.pages, 1);
  assert.match(result.title, /hello/i);
  assert.match(markdown, /^# hello$/im);
  assert.match(markdown, /Hello PDF/);
  assert.match(markdown, /> Pages: 1/);
  console.log("ok");
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
`,
      "utf8",
    );

    const result = spawnSync(tsxBin, [runnerPath], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `expected success, got stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /ok/);
  });
});
