import assert from "node:assert/strict";
import { test } from "node:test";

import initializeExtension from "../index.ts";
import {
  assessClaim,
  buildResearchArtifact,
  buildPassages,
  getResearchArtifact,
  hashContent,
  storeResearchArtifact,
} from "../source-check.ts";
import { clearResults } from "../storage.ts";

const result = (url, snippet, rank = 1) => ({ url, title: "Example", snippet, rank });

test("source-check creates a real SHA-256 hash and exact whitespace offsets", () => {
  const content = "Intro.\n\nThe API\t supports streaming responses.\nTail.";
  const passages = buildPassages(
    [{ rank: 1, url: "https://docs.example.com/api", title: "API", snippet: "API supports streaming responses.", quality: "official_docs" }],
    [{ url: "https://docs.example.com/api", title: "API", content, error: null }],
  );
  const pagePassage = passages.find((passage) => passage.extraction_span);
  assert.ok(pagePassage);
  assert.equal(pagePassage.text, "The API\t supports streaming responses.");
  assert.equal(content.slice(pagePassage.extraction_span.start, pagePassage.extraction_span.end), pagePassage.text);
  assert.equal(hashContent("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("fetched content supplies exact passages when the provider snippet is empty", () => {
  const content = "The API supports streaming responses. Other details follow.";
  const artifact = buildResearchArtifact({
    query: "API supports streaming responses",
    results: [result("https://docs.example.com/api", "")],
    fetched: [{ url: "https://docs.example.com/api", title: "API", content, error: null }],
  });
  assert.deepEqual(artifact.passages.map((passage) => passage.text), ["The API supports streaming responses."]);
  assert.deepEqual(artifact.passages[0].extraction_span, { start: 0, end: 37 });
});

test("fetched passages keep sentences whole across internal periods such as domain names", () => {
  const content = "He said \"intro.\" A number of domains such as example.com and example.org are maintained for documentation purposes. Tail.";
  const passages = buildPassages(
    [{ rank: 1, url: "https://www.iana.org/domains/reserved", title: "Reserved", snippet: "", quality: "official_docs" }],
    [{ url: "https://www.iana.org/domains/reserved", title: "Reserved", content, error: null }],
    "example.com and example.org documentation",
  );
  const expected = "A number of domains such as example.com and example.org are maintained for documentation purposes.";
  assert.deepEqual(passages.map((passage) => passage.text), [expected]);
  assert.equal(content.slice(passages[0].extraction_span.start, passages[0].extraction_span.end), expected);
});

test("fetched passages are picked by the claim, including short acronyms, even when a snippet exists", () => {
  const content = "Tell us about the tls setup. Pricing starts at five dollars a month. Every request requires a token. Connections to the API use TLS only. Rapid capital growth requires patience.";
  const passages = buildPassages(
    [{ rank: 1, url: "https://docs.example.com/api", title: "API", snippet: "Pricing starts at five dollars.", quality: "official_docs" }],
    [{ url: "https://docs.example.com/api", title: "API", content, error: null }],
    "API requires TLS",
  );
  assert.deepEqual(passages.slice(1).map((passage) => passage.text), [
    "Connections to the API use TLS only.",
    "Every request requires a token.",
    "Rapid capital growth requires patience.",
  ]);
});

// Reproduces a real OpenAI-provider result: the snippet was cut from OpenAI's answer, not from the npm docs page.
const GENERATED_SNIPPET = "The minor number is effectively the breaking-change boundary. (docs.npmjs.com)";
const SEMVER_PAGE = "Caret Ranges. Many authors treat a 0.x version as if the x were the major \"breaking-change\" indicator. Unrelated tail.";

test("generated provider snippets are labelled when no page text is available", () => {
  const artifact = buildResearchArtifact({
    query: "a 0.x minor bump is breaking",
    results: [
      { ...result("https://docs.npmjs.com/semver", GENERATED_SNIPPET), snippetSource: "generated" },
      result("https://example.org/page", "Exa page text about breaking changes.", 2),
    ],
  });
  assert.equal(artifact.sources[0].snippet_source, "generated");
  assert.equal(artifact.sources[1].snippet_source, undefined);
  assert.equal(artifact.passages[0].origin, "provider_summary");
  assert.equal(artifact.passages[0].text, GENERATED_SNIPPET);
  assert.equal(artifact.passages[1].origin, undefined);
});

test("a generated snippet stays labelled next to fetched page text", () => {
  const url = "https://docs.npmjs.com/semver";
  const artifact = buildResearchArtifact({
    query: "a 0.x minor bump is a breaking change",
    results: [{ ...result(url, GENERATED_SNIPPET), snippetSource: "generated" }],
    fetched: [{ url, title: "semver", content: SEMVER_PAGE, error: null }],
  });
  const [snippet, ...pagePassages] = artifact.passages;
  assert.equal(snippet.origin, "provider_summary");
  assert.equal(snippet.text, GENERATED_SNIPPET);
  assert.ok(pagePassages.length > 0);
  for (const passage of pagePassages) {
    assert.equal(passage.origin, undefined);
    assert.equal(SEMVER_PAGE.slice(passage.extraction_span.start, passage.extraction_span.end), passage.text);
  }
});

test("a generated snippet is kept, labelled, when the page fetch fails", () => {
  const url = "https://docs.npmjs.com/semver";
  const artifact = buildResearchArtifact({
    query: "breaking change",
    results: [{ ...result(url, GENERATED_SNIPPET), snippetSource: "generated" }],
    fetched: [{ url, title: "", content: "", error: "HTTP 503" }],
  });
  assert.deepEqual(artifact.passages.map((passage) => passage.origin), ["provider_summary"]);
});

test("source_check labels OpenAI citation snippets as provider summary text", async () => {
  await withProviderKey("OPENAI_API_KEY", async () => new Response(JSON.stringify({
    output: [{ type: "web_search_call", action: { sources: [] } }, {
      type: "message",
      content: [{
        type: "output_text",
        text: `For 0.x versions a minor bump can be breaking. ${GENERATED_SNIPPET}`,
        annotations: [{ type: "url_citation", url: "https://docs.npmjs.com/semver", title: "semver", start_index: 10, end_index: 40 }],
      }],
    }],
  }), { status: 200 }), async () => {
    const { tool } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "0.x minor bump is breaking", provider: "openai" }, undefined, undefined, { modelRegistry: {} });
    const passage = response.details.artifact.passages[0];
    assert.equal(passage.origin, "provider_summary");
    assert.match(response.content[0].text, /- p-1-0 \[provider summary, not page text\]: For 0\.x/);
  });
});

test("artifact assembly handles omitted domain filters and failed fetches", () => {
  const artifact = buildResearchArtifact({
    query: "API claim",
    results: [result("https://example.com/a", "The API is confirmed.")],
    fetched: [{ url: "https://example.com/a", title: "Example", content: "", error: "blocked" }],
  });
  assert.equal(artifact.filters.domain_include.length, 0);
  assert.equal(artifact.sources[0].fetched, false);
  assert.equal(artifact.sources[0].fetch_error, "blocked");
  assert.equal(artifact.sources[0].content_hash, undefined);
  assert.equal(typeof artifact.sources[0].fetch_timestamp, "number");
});

test("claim assessment preserves passages and storage without semantic passage labels", () => {
  clearResults();
  const artifact = buildResearchArtifact({
    query: "API claim",
    results: [result("https://example.com/a", "According to the API documentation, the API is confirmed.")],
  });
  const assessed = { ...artifact, claims: [assessClaim("API documentation is confirmed", artifact.passages)] };
  storeResearchArtifact(assessed);
  assert.ok(assessed.id);
  assert.deepEqual(getResearchArtifact(assessed.id), assessed);
  assert.equal(assessed.claims[0].status, "unclear");
  assert.deepEqual(assessed.claims[0].supporting_passages, []);
  assert.deepEqual(assessed.claims[0].contradicting_passages, []);
  assert.deepEqual(assessed.passages.map((passage) => passage.passage_id), ["p-1-0"]);
});

test("claim assessment does not support the exact issue claim from an unrelated confirmed marker", () => {
  const assessment = assessClaim(
    "pi-goal-x is developed by Anthropic officially and only supports Claude models",
    [{
      passage_id: "p-5-1",
      source_url: "fixture://fork",
      source_rank: 1,
      text: "The extension is designed around one rule: the user owns intent; the agent executes only after the goal is explicit and confirmed.",
    }],
  );
  assert.equal(assessment.status, "unclear");
  assert.equal(assessment.confidence, 0.3);
  assert.deepEqual(assessment.supporting_passages, []);
  assert.deepEqual(assessment.contradicting_passages, []);
  assert.match(assessment.rationale, /review the cited passages manually/i);
});

test("duplicate marker passages cannot amplify a semantic verdict", () => {
  const claim = "pi-goal-x is developed by Anthropic officially and only supports Claude models";
  const passages = Array.from({ length: 6 }, (_, index) => ({
    passage_id: `p-${index + 1}-1`,
    source_url: `fixture://fork-${index + 1}`,
    source_rank: index + 1,
    text: "The extension is designed around one rule: the user owns intent; the agent executes only after the goal is explicit and confirmed.",
  }));
  const onePassage = assessClaim(claim, passages.slice(0, 1));
  const duplicates = assessClaim(claim, passages);
  assert.equal(duplicates.status, "unclear");
  assert.equal(duplicates.confidence, onePassage.confidence);
  assert.deepEqual(duplicates.supporting_passages, []);
  assert.deepEqual(duplicates.contradicting_passages, []);
});

test("contradiction markers do not produce semantic passage labels", () => {
  const claim = "The API supports streaming responses";
  const assessment = assessClaim(claim, [{
    passage_id: "p-1-1",
    source_url: "fixture://denial",
    source_rank: 1,
    text: "The API supports streaming responses claim is false and incorrect.",
  }]);
  assert.equal(assessment.status, "unclear");
  assert.deepEqual(assessment.supporting_passages, []);
  assert.deepEqual(assessment.contradicting_passages, []);
});

test("claim assessment only uses missing-evidence when no passages were retrieved", () => {
  const missing = assessClaim("API supports streaming responses", []);
  assert.equal(missing.status, "missing-evidence");
  assert.equal(missing.confidence, 0.2);
});

function registerSourceCheck() {
  const tools = [];
  const entries = [];
  initializeExtension({
    registerTool(tool) { tools.push(tool); },
    registerCommand() {},
    registerShortcut() {},
    on() {},
    appendEntry(type, data) { entries.push({ type, data }); },
  });
  return { tool: tools.find((candidate) => candidate.name === "source_check"), entries };
}

async function withProviderKey(envName, fetchImpl, run) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env[envName];
  process.env[envName] = "source-check-test-key";
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env[envName];
    else process.env[envName] = previousKey;
  }
}

test("source_check executes a successful OpenAI provider response with runtime context", async () => {
  await withProviderKey("OPENAI_API_KEY", async (url) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    return new Response(JSON.stringify({
      output: [
        { type: "web_search_call", action: { sources: [{ title: "API docs", url: "https://docs.example.com/api" }] } },
        { type: "message", content: [{ type: "output_text", text: "The API supports streaming responses." }] },
      ],
    }), { status: 200 });
  }, async () => {
    const { tool, entries } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "API supports streaming responses", provider: "openai" }, undefined, undefined, { modelRegistry: {} });
    assert.equal(response.details.sourceCount, 1);
    assert.equal(response.details.passageCount, 0);
    assert.equal(entries[0].type, "web-search-results");
  });
});

test("source_check stops on cancellation instead of continuing queries", async () => {
  let calls = 0;
  const controller = new AbortController();
  await withProviderKey("OPENAI_API_KEY", async () => {
    calls++;
    controller.abort();
    throw new Error("AbortError: canceled");
  }, async () => {
    const { tool } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "cancel this", queries: ["first", "second"], provider: "openai" }, controller.signal, undefined, { modelRegistry: {} });
    assert.equal(calls, 1);
    assert.equal(response.details.sourceCount, 0);
  });
});

test("source_check retains a rejected page fetch in the artifact", async () => {
  await withProviderKey("OPENAI_API_KEY", async (url) => {
    if (String(url) === "https://api.openai.com/v1/responses") {
      return new Response(JSON.stringify({
        output: [{ type: "web_search_call", action: { sources: [{ title: "API docs", url: "https://example.com/api" }] } }],
      }), { status: 200 });
    }
    throw new Error("fetch rejected");
  }, async () => {
    const { tool } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "API docs", provider: "openai", fetchContent: true }, undefined, undefined, { modelRegistry: {} });
    assert.equal(response.details.sourceCount, 1);
    assert.match(response.details.artifact.sources[0].fetch_error, /^fetch rejected/);
  });
});

test("source_check shows each source's passages in its result, capped at 4,000 characters", async () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    title: `Doc ${index + 1}`,
    url: `https://docs.example.com/${index + 1}`,
    description: (index === 0 ? "L" : String.fromCharCode(97 + index)).repeat(index === 0 ? 600 : index === 14 ? 50 : 300),
  }));
  await withProviderKey("BRAVE_API_KEY", async () => Response.json({ web: { results } }), async () => {
    const { tool } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "API supports streaming", provider: "brave", numResults: 20 }, undefined, undefined, { modelRegistry: {} });
    const text = response.content[0].text;
    assert.match(text, /1\. \[official_docs\] Doc 1\n {3}https:\/\/docs\.example\.com\/1\n {3}- p-1-0: L{400}…\n2\./);
    assert.match(text, new RegExp(`- p-12-0: ${"l".repeat(300)}\\n`));
    assert.doesNotMatch(text, /p-13-0/);
    assert.match(text, new RegExp(`- p-15-0: ${"o".repeat(50)}\\n`));
    assert.match(text, /\n7 more passages in the artifact\.\n/);
    assert.equal(response.details.artifact.passages[0].text.length, 600);
  });
});

test("registered source_check validates the claim at runtime", async () => {
  const tools = [];
  initializeExtension({
    registerTool(tool) { tools.push(tool); },
    registerCommand() {},
    registerShortcut() {},
    on() {},
  });
  const tool = tools.find((candidate) => candidate.name === "source_check");
  assert.ok(tool);
  const response = await tool.execute("call", { claim: "   " });
  assert.equal(response.details.error, "Missing claim");
});
