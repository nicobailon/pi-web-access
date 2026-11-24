import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const moduleUrl = new URL("../github-issue-pr.ts", import.meta.url).href;
for (const ghAvailable of [false, true]) {
 test(`rate-limit guidance when gh is ${ghAvailable ? "available" : "unavailable"}`, () => {
  const stubs = {
   "./github-api.ts": "export const checkGhAvailable = async () => " + ghAvailable + "; export const showGhHint = () => {};",
   "./utils.ts": "export const getWebSearchConfigPath = () => '';",
   "./ssrf-protection.ts": "export const loadSsrfConfig = () => ({ allowRanges: [], trustEnvProxy: false }); export const loadFetchContentDomainPolicy = () => ({}); export const fetchRemoteUrl = async () => new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });",
  };
  const result = spawnSync(process.execPath, ["--input-type=module"], {
   encoding: "utf8",
   timeout: 30000,
   input: `
    import childProcess from "node:child_process";
    import { registerHooks, syncBuiltinESMExports } from "node:module";
    let ghCalls = 0;
    childProcess.execFile = (command, _args, _options, callback) => {
     if (command !== "gh") throw new Error("Unexpected child process: " + command);
     ghCalls++;
     queueMicrotask(() => callback(Object.assign(new Error("Mock gh failure"), { code: 1 }), "", "Mock gh failure"));
    };
    syncBuiltinESMExports();
    registerHooks({ resolve(specifier, context, nextResolve) {
     const stubs = ${JSON.stringify(stubs)};
     if (Object.hasOwn(stubs, specifier)) return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
     return nextResolve(specifier, context);
    }});
    const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
    const result = await extractGitHubIssuePr("https://github.com/owner/repo/issues/12", undefined, { lookup: async () => [{ address: "140.82.112.6", family: 4 }] });
    console.log(JSON.stringify({ result, ghCalls }));
   `,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ghCalls, ghAvailable ? 1 : 0);
  const content = payload.result.content;
  assert.match(content, /rate limit/i);
  if (ghAvailable) assert.match(content, /gh auth login/);
  else { assert.match(content, /PATH/); assert.match(content, /anonymous|unauthenticated/i); assert.doesNotMatch(content, /gh auth login/); }
 });
}
