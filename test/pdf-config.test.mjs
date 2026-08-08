import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPDFResponseBuffer } from "../extract.ts";

const pdfModuleUrl = new URL("../pdf-extract.ts", import.meta.url).href;

test("pdf.maxSizeMB defaults to 20 and accepts values through 50", () => {
	assert.equal(readConfig(undefined).maxSizeMB, 20);
	assert.equal(readConfig({ pdf: { maxSizeMB: 30 } }).maxSizeMB, 30);
	assert.equal(readConfig({ pdf: { maxSizeMB: 50 } }).maxSizeMB, 50);
});

test("pdf.maxSizeMB caps values above 50 and rejects invalid values", () => {
	assert.equal(readConfig({ pdf: { maxSizeMB: 80 } }).maxSizeMB, 50);
	assert.equal(readConfig({ pdf: { maxSizeMB: 0 } }).maxSizeMB, 20);
	assert.equal(readConfig({ pdf: { maxSizeMB: -1 } }).maxSizeMB, 20);
	assert.equal(readConfig({ pdf: { maxSizeMB: "50" } }).maxSizeMB, 20);
});

test("pdf.provider defaults to auto and validates explicit providers", () => {
	assert.equal(readConfig(undefined).provider, "auto");
	assert.equal(readConfig({ pdf: { provider: "gemini" } }).provider, "gemini");
	assert.equal(
		readConfig({ pdf: { provider: "datalab" } }).provider,
		"datalab",
	);
	assert.equal(readConfig({ pdf: { provider: "unpdf" } }).provider, "unpdf");
	assert.equal(readConfig({ pdf: { provider: "gemini2" } }).provider, "auto");
});

test("pdf.datalabMode defaults to balanced and validates modes", () => {
	assert.equal(readConfig(undefined).datalabMode, "balanced");
	assert.equal(
		readConfig({ pdf: { datalabMode: "fast" } }).datalabMode,
		"fast",
	);
	assert.equal(
		readConfig({ pdf: { datalabMode: "accurate" } }).datalabMode,
		"accurate",
	);
	assert.equal(
		readConfig({ pdf: { datalabMode: "ultra" } }).datalabMode,
		"balanced",
	);
});

test("pdf.datalabTimeoutMs defaults to 120000 and caps at 300000", () => {
	assert.equal(readConfig(undefined).datalabTimeoutMs, 120000);
	assert.equal(
		readConfig({ pdf: { datalabTimeoutMs: 5000 } }).datalabTimeoutMs,
		5000,
	);
	assert.equal(
		readConfig({ pdf: { datalabTimeoutMs: 999999 } }).datalabTimeoutMs,
		300000,
	);
	assert.equal(
		readConfig({ pdf: { datalabTimeoutMs: -1 } }).datalabTimeoutMs,
		120000,
	);
});

test("PDF streamed byte enforcement allows the exact limit", async () => {
	const bytes = Uint8Array.from([1, 2]);
	const maxSizeMB = bytes.byteLength / 1024 / 1024;
	const response = new Response(bytes, {
		headers: { "content-type": "application/pdf" },
	});

	const buffer = await readPDFResponseBuffer(response, maxSizeMB);
	assert.deepEqual(new Uint8Array(buffer), bytes);
});

test("PDF streamed byte enforcement rejects a headerless response above the limit", async () => {
	const maxSizeMB = 2 / 1024 / 1024;
	const response = new Response(Uint8Array.from([1, 2, 3]), {
		headers: { "content-type": "application/pdf" },
	});

	await assert.rejects(
		readPDFResponseBuffer(response, maxSizeMB),
		/PDF exceeds configured pdf\.maxSizeMB limit/,
	);
});

function readConfig(config) {
	const configDir = mkdtempSync(join(tmpdir(), "pi-web-access-pdf-config-"));
	try {
		if (config !== undefined) {
			writeFileSync(join(configDir, "web-search.json"), JSON.stringify(config));
		}
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(configDir)};
				delete process.env.DATALAB_MODE;
				const { loadPDFConfig } = await import(${JSON.stringify(pdfModuleUrl)});
				console.log(JSON.stringify(loadPDFConfig()));
			`,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: configDir },
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim());
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
}
