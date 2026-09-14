import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const searchUrl = new URL("../gemini-search.ts", import.meta.url).href;

function homeWith(config) {
  const home = mkdtempSync(join(tmpdir(), "pi-web-access-allowed-"));
  if (config !== undefined) writeFileSync(join(home, "web-search.json"), JSON.stringify(config) + "\n");
  return home;
}

function child(config, script, extraEnv = {}) {
  const home = homeWith(config);
  const env = { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home"), ...extraEnv };
  return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env });
}

const kagiResponse = `new Response(JSON.stringify({ data: { search: [{ title: "Kagi", url: "https://example.com/kagi", snippet: "answer" }] } }), { status: 200 })`;

test("Kagi-only policy constrains schema and generated description", () => {
  const result = child({ webSearch: { allowedProviders: ["kagi"] } }, `
    const tools = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
    const search = tools.find(t => t.name === "web_search");
    const source = tools.find(t => t.name === "source_check");
    console.log(JSON.stringify({ description: search.description, searchProvider: search.parameters.properties.provider, sourceProvider: source.parameters.properties.provider }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.description, /Search the web with Kagi\./);
  assert.doesNotMatch(output.description, /Brave/);
  for (const schema of [output.searchProvider, output.sourceProvider]) {
    assert.deepEqual(schema.anyOf[0].enum, ["auto", "all", "kagi"]);
    assert.deepEqual(schema.anyOf[1].items.enum, ["kagi"]);
  }
});

test("Kagi-only policy generates Curator choices without disabled providers", () => {
  const result = child({ webSearch: { allowedProviders: ["kagi"] }, kagiApiKey: "k", autoOpenBrowser: false, curatorTimeoutSeconds: 5 }, `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url) === "https://kagi.com/api/v1/search" ? ${kagiResponse} : nativeFetch(url, init);
    const tools = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
    const tool = tools.find(t => t.name === "web_search");
    const controller = new AbortController();
    let revealUrl;
    const urlReady = new Promise(resolve => { revealUrl = resolve; });
    const ctx = { modelRegistry: { getAvailable() { return []; }, find() { return undefined; } }, cwd: "", isProjectTrusted() { return true; }, ui: { notify() {} } };
    const execution = tool.execute("call", { query: "q", provider: "kagi", workflow: "summary-review" }, controller.signal, update => {
      if (update.details?.curatorUrl) revealUrl(update.details.curatorUrl);
    }, ctx);
    const url = await Promise.race([urlReady, new Promise((_, reject) => setTimeout(() => reject(new Error("Curator URL timeout")), 3000))]);
    const html = await (await nativeFetch(url)).text();
    controller.abort();
    await execution;
    console.log(JSON.stringify({ hasKagi: html.includes('data-provider="kagi"'), hasBrave: html.includes('data-provider="brave"') }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { hasKagi: true, hasBrave: false });
});

test("Curator represents unavailable auto honestly while keeping explicit Serply immediately selectable", () => {
  const result = child({ webSearch: { allowedProviders: ["serply"] }, serplyApiKey: "s", autoOpenBrowser: false, curatorTimeoutSeconds: 5 }, `
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url) === "https://api.serply.io/v1/search"
      ? new Response(JSON.stringify({ results: [{ title: "Serply", link: "https://example.com/serply", description: "answer" }] }), { status: 200 })
      : nativeFetch(url, init);
    const tools = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
    const tool = tools.find(t => t.name === "web_search");
    const ctx = { modelRegistry: { getAvailable() { return []; }, find() { return undefined; } }, cwd: "", isProjectTrusted() { return true; }, ui: { notify() {} } };
    async function curatorHtml(provider) {
      const controller = new AbortController();
      let revealUrl;
      const urlReady = new Promise(resolve => { revealUrl = resolve; });
      const execution = tool.execute("call-" + provider, { query: "q", provider, workflow: "summary-review" }, controller.signal, update => {
        if (update.details?.curatorUrl) revealUrl(update.details.curatorUrl);
      }, ctx);
      const url = await Promise.race([urlReady, new Promise((_, reject) => setTimeout(() => reject(new Error("Curator URL timeout")), 3000))]);
      const html = await (await nativeFetch(url)).text();
      controller.abort();
      await execution;
      return html;
    }
    const autoHtml = await curatorHtml("auto");
    const explicitHtml = await curatorHtml("serply");
    console.log(JSON.stringify({
      autoDefault: autoHtml.includes('"defaultProvider":"auto"'),
      autoSearch: autoHtml.includes('"searchProvider":"auto"'),
      autoSerplyIdle: /class="provider-btn idle" data-provider="serply"/.test(autoHtml),
      explicitDefault: explicitHtml.includes('"defaultProvider":"serply"'),
      explicitSearch: explicitHtml.includes('"searchProvider":"serply"'),
      explicitSerplyLoading: /class="provider-btn loading is-default" data-provider="serply"/.test(explicitHtml),
    }));
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    autoDefault: true,
    autoSearch: true,
    autoSerplyIdle: true,
    explicitDefault: true,
    explicitSearch: true,
    explicitSerplyLoading: true,
  });
});

test("disabled scalar and array selections fail before provider requests", () => {
  const result = child({ webSearch: { allowedProviders: ["kagi"] }, kagiApiKey: "k" }, `
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
    const { search } = await import(${JSON.stringify(searchUrl)});
    const errors = [];
    for (const provider of ["brave", ["kagi", "brave"]]) try { await search("q", { provider }); } catch (e) { errors.push(String(e)); }
    console.log(JSON.stringify({ calls, errors }));
  `, { BRAVE_API_KEY: "b" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.calls, 0);
  assert.equal(output.errors.length, 2);
  assert.ok(output.errors.every(error => /disabled provider/.test(error)));
});

test("web_search and Curator reject disabled providers before availability or requests", () => {
  for (const workflow of ["none", "summary-review"]) {
    const result = child({ webSearch: { allowedProviders: ["kagi"] } }, `
      let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
      const tools = [];
      (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {} });
      const tool = tools.find(t => t.name === "web_search");
      const ctx = { modelRegistry: new Proxy({}, { get() { throw new Error("availability must not run"); } }) };
      let error; try { await tool.execute("call", { query: "q", provider: "brave", workflow: ${JSON.stringify(workflow)} }, undefined, undefined, ctx); } catch (e) { error = String(e); }
      console.log(JSON.stringify({ calls, error }));
    `, { BRAVE_API_KEY: "b" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.calls, 0);
    assert.match(output.error, /disabled provider/);
    assert.doesNotMatch(output.error, /availability must not run/);
  }
});

test("auto and all filter to allowed providers", () => {
  for (const provider of ["auto", "all"]) {
    const result = child({ webSearch: { allowedProviders: ["kagi"] }, kagiApiKey: "k" }, `
      const calls = []; globalThis.fetch = async url => { calls.push(String(url)); if (String(url) === "https://kagi.com/api/v1/search") return ${kagiResponse}; throw new Error("disabled request " + url); };
      const { search } = await import(${JSON.stringify(searchUrl)});
      const output = await search("q", { provider: ${JSON.stringify(provider)} });
      console.log(JSON.stringify({ provider: output.provider, calls }));
    `, { BRAVE_API_KEY: "b", EXA_API_KEY: "e" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.calls, ["https://kagi.com/api/v1/search"]);
    assert.equal(output.provider, provider === "all" ? "all" : "kagi");
  }
});

test("allowlisting an explicit-only provider does not opt it into auto or all", () => {
  for (const provider of ["auto", "all"]) {
    const result = child({ webSearch: { allowedProviders: ["serply"] }, serplyApiKey: "s" }, `
      let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
      const { search } = await import(${JSON.stringify(searchUrl)});
      let error; try { await search("q", { provider: ${JSON.stringify(provider)} }); } catch (e) { error = String(e); }
      console.log(JSON.stringify({ calls, error }));
    `);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.calls, 0);
    assert.match(output.error, /No search provider available|No configured search provider available/);
  }
});

test("an allowlisted explicit-only provider remains directly selectable with its credential", () => {
  const result = child({ webSearch: { allowedProviders: ["serply"] }, serplyApiKey: "s" }, `
    const calls = []; globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), key: new Headers(init.headers).get("x-api-key") });
      return new Response(JSON.stringify({ results: [{ title: "Serply", link: "https://example.com/serply", description: "answer" }] }), { status: 200 });
    };
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q", { provider: "serply" });
    console.log(JSON.stringify({ provider: response.provider, calls }));
  `);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "serply");
  assert.equal(output.calls.length, 1);
  assert.equal(output.calls[0].key, "s");
});

test("source_check cannot bypass policy", () => {
  const result = child({ webSearch: { allowedProviders: ["kagi"] } }, `
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
    const tools = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
    const tool = tools.find(t => t.name === "source_check");
    const response = await tool.execute("call", { claim: "claim", provider: "brave" }, undefined, undefined, { modelRegistry: {} });
    console.log(JSON.stringify({ calls, details: response.details }));
  `, { BRAVE_API_KEY: "b" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.calls, 0);
  assert.match(JSON.stringify(output.details), /disabled provider/);
});

test("an absent config file preserves registration and search behavior", () => {
  const result = child(undefined, `
    const tools = []; const commands = [];
    (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand(name) { commands.push(name); }, registerShortcut() {}, on() {} });
    const providers = tools.find(t => t.name === "web_search").parameters.properties.provider.anyOf[0].enum;
    globalThis.fetch = async () => ${kagiResponse};
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q", { provider: "kagi" });
    console.log(JSON.stringify({ tools: tools.map(t => t.name), commands, hasSerply: providers.includes("serply"), provider: response.provider }));
  `, { KAGI_API_KEY: "k" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    tools: ["web_search", "source_check", "fetch_content", "get_search_content"],
    commands: ["websearch", "curator", "google-account", "search"],
    hasSerply: true,
    provider: "kagi",
  });
});

test("invalid allowlists fail tool registration clearly", () => {
  for (const [allowedProviders, pattern] of [
    [[], /must be a non-empty array/],
    [["kagi", "KAGI"], /must not contain duplicates: kagi/],
    [["not-a-provider"], /contains an invalid provider: not-a-provider/],
    ["kagi", /must be a non-empty array/],
  ]) {
    const result = child({ webSearch: { allowedProviders } }, `
      (await import(${JSON.stringify(indexUrl)})).default({ registerTool() {}, registerCommand() {}, registerShortcut() {}, on() {} });
    `);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /webSearch\.allowedProviders/);
  }
});

test("a configured auto default retains automatic allowlist behavior", () => {
  const result = child({ webSearch: { allowedProviders: ["kagi"] }, provider: "auto", kagiApiKey: "k" }, `
    const calls = []; globalThis.fetch = async url => { calls.push(String(url)); if (String(url) === "https://kagi.com/api/v1/search") return ${kagiResponse}; throw new Error("disabled request " + url); };
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q");
    console.log(JSON.stringify({ provider: response.provider, calls }));
  `, { BRAVE_API_KEY: "b", SERPLY_API_KEY: "s" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { provider: "kagi", calls: ["https://kagi.com/api/v1/search"] });
});

test("source_check follows an allowed routing fallback", () => {
  const result = child({
    webSearch: { allowedProviders: ["brave", "kagi"] },
    searchRouting: { providers: ["brave", "kagi"], fallbackOn: ["network"] },
    kagiApiKey: "k",
  }, `
    const calls = []; globalThis.fetch = async url => {
      calls.push(String(url));
      if (String(url).startsWith("https://api.search.brave.com/")) throw new TypeError("fetch failed");
      if (String(url) === "https://kagi.com/api/v1/search") return ${kagiResponse};
      throw new Error("disabled request " + url);
    };
    const tools = []; (await import(${JSON.stringify(indexUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
    const response = await tools.find(t => t.name === "source_check").execute("call", { claim: "q" }, undefined, undefined, { modelRegistry: {} });
    console.log(JSON.stringify({ provider: response.details.artifact.provider, calls, errors: response.details.artifact.errors || [] }));
  `, { BRAVE_API_KEY: "b" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, "kagi");
  assert.equal(output.errors.length, 0);
  assert.equal(output.calls.length, 2);
  assert.ok(output.calls[0].startsWith("https://api.search.brave.com/"));
  assert.equal(output.calls[1], "https://kagi.com/api/v1/search");
});

test("configured defaults and routing cannot reference disabled providers", () => {
  for (const config of [
    { webSearch: { allowedProviders: ["kagi"] }, provider: "brave" },
    { webSearch: { allowedProviders: ["kagi"] }, searchRouting: { providers: ["brave"], fallbackOn: ["network"] } },
  ]) {
    const result = child(config, `
      let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
      try { await (await import(${JSON.stringify(searchUrl)})).search("q"); } catch (e) { console.log(JSON.stringify({ calls, error: String(e) })); }
    `);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.calls, 0);
    assert.match(output.error, /disabled provider/);
  }
});

test("both configured provider aliases are validated while searchProvider keeps precedence", () => {
  const rejected = child({ webSearch: { allowedProviders: ["kagi"] }, searchProvider: "kagi", provider: "brave" }, `
    let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
    try { await (await import(${JSON.stringify(searchUrl)})).search("q"); } catch (e) { console.log(JSON.stringify({ calls, error: String(e) })); }
  `, { BRAVE_API_KEY: "b", KAGI_API_KEY: "k" });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).calls, 0);
  assert.match(JSON.parse(rejected.stdout).error, /provider in .* references disabled provider "brave"/);

  const accepted = child({ webSearch: { allowedProviders: ["kagi", "brave"] }, searchProvider: "kagi", provider: "brave", kagiApiKey: "k" }, `
    const calls = []; globalThis.fetch = async url => { calls.push(String(url)); return ${kagiResponse}; };
    const response = await (await import(${JSON.stringify(searchUrl)})).search("q");
    console.log(JSON.stringify({ provider: response.provider, calls }));
  `, { BRAVE_API_KEY: "b" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { provider: "kagi", calls: ["https://kagi.com/api/v1/search"] });
});
