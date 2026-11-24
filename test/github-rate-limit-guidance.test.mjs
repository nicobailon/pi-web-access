import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const moduleUrl = new URL("../github-issue-pr.ts", import.meta.url).href;
for (const ghAvailable of [false, true]) {
 test(`rate-limit guidance when gh is ${ghAvailable ? "available" : "unavailable"}`, () => {
  const stub = "export const checkGhAvailable = async () => " + ghAvailable + "; export const showGhHint = () => {};";
  const result = spawnSync(process.execPath, ["--input-type=module"], {
   encoding: "utf8",
   input: `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
     if (specifier === "./github-api.ts") return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(stub))}, shortCircuit: true };
     return nextResolve(specifier, context);
    }});
    globalThis.fetch = async () => new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify(await extractGitHubIssuePr("https://github.com/owner/repo/issues/12", undefined, { lookup: async () => [{ address: "140.82.112.6", family: 4 }] })));
   `,
  });
  assert.equal(result.status, 0, result.stderr);
  const content = JSON.parse(result.stdout.trim()).content;
  assert.match(content, /rate limit/i);
  if (ghAvailable) assert.match(content, /gh auth login/);
  else { assert.match(content, /PATH/); assert.match(content, /anonymous|unauthenticated/i); assert.doesNotMatch(content, /gh auth login/); }
 });
}
