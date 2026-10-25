import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { showUpgradeNotice } from "../upgrade-notice.ts";

const CHANGELOG = "## [Unreleased]\n\n### Highlights\n\n- Unreleased.\n\n## [0.3.0]\n\n### Highlights\n\n- Newest [highlight](https://example.com).\n\n### Fixed\n\n- Not a highlight.\n\n## [0.2.0]\n\n### Highlights\n\n- Middle highlight.\n\n## [0.1.0]\n\n### Highlights\n\n- Already seen.\n";

test("announces each upgrade's highlights once, only in a UI session", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pwa-upgrade-notice-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const changelog = join(dir, "CHANGELOG.md");
	writeFileSync(changelog, CHANGELOG);
	const notices = [];
	const start = (version, hasUI = true) => showUpgradeNotice({ hasUI, ui: { notify: (message) => notices.push(message) } }, dir, changelog, version);

	await start("0.1.0", false);
	assert.equal(existsSync(join(dir, "last-seen-version.json")), false);
	await start("0.1.0");
	await start("0.1.0");
	assert.deepEqual(notices, []);
	await start("0.3.0");
	await start("0.3.0");
	assert.deepEqual(notices, ["pi-web-access updated from 0.1.0 to 0.3.0\n- Newest highlight.\n- Middle highlight.\nChangelog: https://github.com/nicobailon/pi-web-access/blob/main/CHANGELOG.md"]);
	await start("0.2.0");
	writeFileSync(join(dir, "last-seen-version.json"), "{");
	await start("0.3.0");
	assert.deepEqual([notices.length, JSON.parse(readFileSync(join(dir, "last-seen-version.json"), "utf-8"))], [1, { version: "0.3.0" }]);
});

test("starts quietly when the seen version cannot be recorded", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pwa-upgrade-notice-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const changelog = join(dir, "CHANGELOG.md");
	writeFileSync(changelog, CHANGELOG);
	writeFileSync(join(dir, "not-a-directory"), "");
	const notices = [];
	await showUpgradeNotice({ hasUI: true, ui: { notify: (message) => notices.push(message) } }, join(dir, "not-a-directory", "pi-web-access"), changelog, "0.3.0");
	assert.deepEqual(notices, []);
});
