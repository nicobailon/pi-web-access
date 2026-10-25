// Loaded by `npm test` before the runner spawns test files. Tests write and prune the
// fetched-content cache, so a cache root exported in the shell must never reach them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
delete process.env.PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS;
delete process.env.CLOUDFLARE_GATEWAY_ID;
process.env.METADATA_SERVER_DETECTION = "none";

// Config lookups fall back to ~/.pi/agent/web-search.json, so a developer's own config (for example
// webSearch.allowedProviders) must not reach tests that don't write one. Child processes inherit both
// variables; os.homedir() reads USERPROFILE on Windows.
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;
const home = mkdtempSync(join(tmpdir(), "pi-web-access-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
