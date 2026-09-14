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

test("source_check executes a successful OpenAI provider response with runtime context", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "source-check-test-key";
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    return new Response(JSON.stringify({
      output: [
        { type: "web_search_call", action: { sources: [{ title: "API docs", url: "https://docs.example.com/api" }] } },
        { type: "message", content: [{ type: "output_text", text: "The API supports streaming responses." }] },
      ],
    }), { status: 200 });
  };
  try {
    const { tool, entries } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "API supports streaming responses", provider: "openai" }, undefined, undefined, { modelRegistry: {} });
    assert.equal(response.details.sourceCount, 1);
    assert.equal(response.details.passageCount, 0);
    assert.equal(entries[0].type, "web-search-results");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("source_check stops on cancellation instead of continuing queries", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  const controller = new AbortController();
  process.env.OPENAI_API_KEY = "source-check-test-key";
  globalThis.fetch = async () => {
    calls++;
    controller.abort();
    throw new Error("AbortError: canceled");
  };
  try {
    const { tool } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "cancel this", queries: ["first", "second"], provider: "openai" }, controller.signal, undefined, { modelRegistry: {} });
    assert.equal(calls, 1);
    assert.equal(response.details.sourceCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("source_check retains a rejected page fetch in the artifact", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "source-check-test-key";
  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.openai.com/v1/responses") {
      return new Response(JSON.stringify({
        output: [{ type: "web_search_call", action: { sources: [{ title: "API docs", url: "https://example.com/api" }] } }],
      }), { status: 200 });
    }
    throw new Error("fetch rejected");
  };
  try {
    const { tool } = registerSourceCheck();
    const response = await tool.execute("call", { claim: "API docs", provider: "openai", fetchContent: true }, undefined, undefined, { modelRegistry: {} });
    assert.equal(response.details.sourceCount, 1);
    assert.match(response.details.artifact.sources[0].fetch_error, /^fetch rejected/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
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
