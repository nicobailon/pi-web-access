import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("web_search curator auto-open failures keep the curator alive with a manual URL", () => {
	assert.match(indexSrc, /browserOpenError\?: string;/);
	assert.match(indexSrc, /phase: "curator-fallback"/);
	assert.match(indexSrc, /Search curator is running, but the browser did not open automatically\./);
	assert.match(indexSrc, /Open manually: \$\{handle\.url\}/);
	assert.match(indexSrc, /pc\.browserOpenError = message;/);
	assert.doesNotMatch(indexSrc, /Failed to open curator UI: \$\{message\}`\);\n\t\t\tif \(pendingCurates\.get\(callId\) === pc \|\| \(handle && activeCurators\.get\(callId\) === handle\)\) \{\n\t\t\t\tcloseCurator\(callId\);/);
});

test("cancel diagnostics include curator URL and browser-open error", () => {
	assert.match(indexSrc, /curatorUrl\?: string;/);
	assert.match(indexSrc, /browserOpenError\?: string;/);
	assert.match(indexSrc, /curator: \$\{partial\.curatorUrl\}/);
	assert.match(indexSrc, /browser open error: \$\{partial\.browserOpenError\}/);
});

test("manual websearch command reports browser-open fallback without closing curator", () => {
	assert.match(indexSrc, /let browserOpenError: string \| null = null;/);
	assert.match(indexSrc, /ctx\.ui\.notify\(`Search curator is running, but the browser did not open automatically\. Open manually: \$\{handle\.url\}`/);
	assert.match(indexSrc, /if \(queries\.length > 0\) \{/);
});

test("README documents manual browser fallback", () => {
	assert.match(readmeSrc, /Docker, WSL, SSH, or headless environments/);
	assert.match(readmeSrc, /Copy it into a browser that can reach the Pi host/);
});

test("sendCuratorFallbackUpdate is declared with wider scope than the try block to avoid catch block ReferenceError", () => {
	assert.match(indexSrc, /let sendCuratorFallbackUpdate: \(\(message: string\) => void\) \| null = null;/);
	assert.match(indexSrc, /sendCuratorFallbackUpdate = \(message: string\) => \{/);
});
