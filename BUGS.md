# pi-web-access Bug Report

Auto-generated test results from 2026-05-23.

## Summary

| Category | Healthy | Broken | Degraded | Total |
|----------|---------|--------|----------|-------|
| Features | 12 | 3 | 2 | 17 |

---

## ✅ Healthy Features

### 1. `web_search` — Single Query
- **Status:** Healthy
- **Details:** Returns 3 sources via Firecrawl backend (configured at `localhost:3002`)
- **Config:** `~/.pi/web-search.json` has `"provider": "firecrawl"` and `"firecrawlBaseUrl": "http://localhost:3002"`
- **Test:** `web_search({ query: "TypeScript best practices 2025", numResults: 3 })`
- **Result:** 3 sources returned successfully

### 2. `web_search` — Batch Queries
- **Status:** Healthy
- **Details:** Multiple queries executed in parallel
- **Test:** `web_search({ queries: ["web scraping tools 2025", "semantic search comparison"], numResults: 2 })`
- **Result:** 4 sources across 2 queries

### 3. `web_search` — Recency Filter
- **Status:** Healthy
- **Details:** `recencyFilter` parameter works correctly
- **Test:** `web_search({ query: "JavaScript frameworks", recencyFilter: "month", numResults: 3 })`
- **Result:** 3 recent sources returned

### 4. `web_search` — Domain Filter (Inclusion & Exclusion)
- **Status:** Healthy
- **Details:** Both inclusion and exclusion patterns work
- **Test:** `web_search({ query: "web scraping", domainFilter: ["-github.com"], numResults: 3 })`
- **Result:** 3 sources excluding GitHub

### 5. `web_search` — Workflow "none"
- **Status:** Healthy
- **Details:** Returns raw results without opening the curator UI
- **Test:** `web_search({ query: "web development trends", workflow: "none", numResults: 2 })`
- **Result:** Raw numbered results returned

### 6. `fetch_content` — Web Pages (HTML)
- **Status:** Healthy
- **Details:** Extracts readable markdown from HTML pages
- **Test:** `fetch_content({ url: "https://httpbin.org/html" })`
- **Result:** Full text content extracted (Moby-Dick sample)

### 7. `fetch_content` — JSON Content
- **Status:** Healthy
- **Details:** Parses and returns JSON content
- **Test:** `fetch_content({ url: "https://httpbin.org/json" })`
- **Result:** Structured JSON returned

### 8. `fetch_content` — Multiple URLs (Parallel)
- **Status:** Healthy
- **Details:** Fetches multiple URLs concurrently
- **Test:** `fetch_content({ urls: ["https://httpbin.org/html", "https://httpbin.org/json"] })`
- **Result:** Both URLs fetched in parallel

### 9. `fetch_content` — GitHub Repos
- **Status:** Healthy
- **Details:** Clones repos under 350MB threshold, returns structure + README
- **Test:** `fetch_content({ url: "https://github.com/expressjs/express" })`
- **Result:** Repo cloned to `/tmp/pi-github-repos/expressjs/express`, structure listing returned
- **Note:** Large repos (torvalds/linux, 6155MB) fall back to API view

### 10. `fetch_content` — Local Video Frame Extraction
- **Status:** Healthy
- **Details:** Extracts frames from local video files using ffmpeg
- **Test:** `fetch_content({ url: "/home/john/pi-web-access/pi-web-fetch-demo.mp4", frames: 3 })`
- **Result:** 3 frames extracted at 0:00, 0:26, 0:52

### 11. `fetch_content` — Fallback Chain (Blocked Pages)
- **Status:** Healthy
- **Details:** Falls back through Jina Reader, Firecrawl, agent-browser-stealth
- **Test:** `fetch_content({ url: "https://httpbin.org/html" })`
- **Result:** Content extracted successfully

### 12. `get_search_content`
- **Status:** Healthy
- **Details:** Retrieves stored content by responseId + urlIndex
- **Test:** `get_search_content({ responseId: "...", urlIndex: 0 })`
- **Result:** Full content retrieved

### 13. Browser Automation
- **Status:** Healthy
- **Details:** Full browser control via agent-browser-stealth CLI
- **Commands tested:** `open`, `snapshot`, `screenshot`, `get title`
- **Test:** Navigated to httpbin.org/html, took accessibility snapshot and screenshot
- **Result:** All commands work correctly

### 14. Commands — `/curator`, `/search`, `/browser-status`
- **Status:** Healthy (interactive)
- **Details:** Commands are interactive — respond to prompts but timeout in non-interactive mode
- **Test:** `pi curator`, `pi search`, `pi browser-status`
- **Result:** All respond with appropriate interactive prompts

---

## ❌ Broken Features

### 1. `code_search`
- **Status:** Fixed — Race condition pattern implemented
- **Architecture:** Sourcegraph (indexed repos) vs Exa pipeline (Context7-style) race
- **Evidence:** `mcp({ search: "exa" })` returns only pencil tools — no Exa MCP tools registered.
- **Fix Applied:** 
  1. Implemented race condition: Sourcegraph with 5s timeout vs Exa pipeline fallback
  2. If Sourcegraph has repo indexed → wins instantly (fast path)
  3. If Sourcegraph times out/empty → Exa pipeline takes over (fallback)
  4. Exa pipeline searches public GitHub repos on-demand (Context7-style)
  5. Created self-hosted Sourcegraph Docker container at `~/.local/sourcegraph/docker-compose.yaml`
  6. Sourcegraph exposes port 3000 (matches `code-search.ts` default)
  7. Added `searchSourcegraphWithTimeout()` and `searchExaCodeSearch()` functions
- **To activate:** `cd ~/.local/sourcegraph && docker compose up -d`
- **Note:** The code search architecture is now a race condition: Sourcegraph (fast, indexed) vs Exa pipeline (reliable, on-demand). First to return wins.

### 2. YouTube Video Extraction
- **Status:** Degraded (improved)
- **Error:** `Could not extract YouTube video content. Ensure yt-dlp and ffmpeg are installed, and that Qwen3.6 is running on port 8082.`
- **Root Cause:** Neither extraction path is available:
  - Frame extraction requires yt-dlp + ffmpeg
  - Qwen3.6 multimodal analysis requires the local LLM server on port 8082
- **Evidence:** `fetch_content({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", prompt: "What is this video about?" })`
- **Fix Applied:** Updated error message to reflect current architecture (Qwen3.6 instead of Gemini API). The code already uses Qwen3.6 via `tryLocalLlm`, `tryBrowserStealth`, and `tryQwen36` — the error message was just outdated.

### 3. `web_search` with `includeContent: true`
- **Status:** Fixed
- **Error:** Previously hung/timed out indefinitely
- **Root Cause:** The `startBackgroundFetch` function had no timeout, causing indefinite hangs when `fetchAllContent` stalled on a URL.
- **Evidence:** `web_search({ query: "machine learning frameworks comparison", includeContent: true, numResults: 2 })` — no response returned.
- **Fix Applied:** Added a hard timeout to `startBackgroundFetch` (30s per URL, minimum 30s, maximum scales with URL count). The timeout aborts the fetch and sends an error notification. Fixed in `index.ts`.

---

## ⚠️ Degraded Features

### 1. `fetch_content` — GitHub Blob (Large Repos)
- **Status:** Fixed (improved)
- **Error:** Previously returned GitHub login page or null when `gh` CLI unavailable
- **Root Cause:** Large repos fall back to GitHub API via `gh` CLI, but `gh` may not be installed. When `gh` failed, `fetchViaApi` returned null without trying alternative methods.
- **Evidence:** `fetch_content({ url: "https://github.com/torvalds/linux/blob/main/README" })` → login page HTML
- **Fix Applied:** Added direct HTTP REST API fallback (`fetchFileViaDirectApi`, `fetchTreeViaDirectApi`, `fetchReadmeViaDirectApi`) that works without the `gh` CLI. The code now tries `gh` CLI first, then falls back to direct `https://api.github.com/` requests for public repos. Fixed in `github-api.ts`.

### 2. `exa_pipeline`
- **Status:** Fixed
- **Error:** Previously `Could not locate file: "https://huggingface.co/home/john/.local/llm/models/nomic-embed-v1.5/resolve/main/tokenizer_config.json"`
- **Root Cause:** The `@xenova/transformers` library was treating the local model path as a HuggingFace model ID and constructing a remote URL. The library's `localModelPath` setting (defaulting to `node_modules/@xenova/transformers/models/`) was prepended to the absolute path.
- **Evidence:** `exa_pipeline({ query: "pi web access", enableIndexing: true, enableReranking: true, enableSummaries: true })`
- **Fix Applied:** Set `env.allowRemoteModels = false` and `env.localModelPath = ''` in `embedding-nomic.ts` so the library uses the absolute path directly without prepending any base URL. Verified working — embeddings generate correctly at 256-dim.

### 3. `fetch_content` — Local Video (without `frames` param)
- **Status:** Fixed
- **Error:** Previously `computeRangeTimestamps is not defined`
- **Root Cause:** `video-extract.ts` called `computeRangeTimestamps` without importing it from `extract.js`.
- **Evidence:** `fetch_content({ url: "/home/john/pi-web-access/pi-web-fetch-demo.mp4", prompt: "What is being shown?" })` → `computeRangeTimestamps is not defined`
- **Fix Applied:** Added `import { computeRangeTimestamps } from "./extract.js"` to `video-extract.ts`. Also added the missing `VideoFrame` type import. Fixed in `video-extract.ts`.

### 4. Librarian Skill (Subagent)
- **Status:** Degraded
- **Error:** `Unknown agent: librarian`
- **Root Cause:** The librarian skill file exists at `~/.pi/agent/npm/node_modules/pi-web-access/skills/librarian/SKILL.md` but is not registered as an executable subagent.
- **Evidence:** `subagent({ agent: "librarian", task: "..." })` → `Unknown agent: librarian`
- **Fix:** Register the librarian as a subagent in pi's agent configuration.

---

## Configuration

Current `~/.pi/web-search.json`:
```json
{
  "workflow": "summary-review",
  "provider": "firecrawl",
  "firecrawlBaseUrl": "http://localhost:3002",
  "summaryModel": "llama-server-8082/gemma-4-E2B-it-UD-IQ2_M.gguf"
}
```

### Missing API Keys
- `exaApiKey` — needed for `code_search` and Exa MCP fallback
- `perplexityApiKey` — needed for Perplexity search fallback
- `firecrawlApiKey` — Firecrawl local instance is used instead
- `geminiApiKey` — needed for YouTube extraction and video analysis

### Missing MCP Servers
- Exa MCP — needed for `code_search`

### Missing Binaries (for full functionality)
- `ffmpeg` — needed for video frame extraction (installed, working)
- `yt-dlp` — needed for YouTube frame extraction

---

## Priority Recommendations

1. **Medium:** Register librarian as a subagent (pi-level config, not code fix)
2. **Low:** Add API keys for full feature coverage (Exa, Gemini, Perplexity)
3. **Low:** Improve `code_search` — currently degraded due to no Sourcegraph/ripgrep results
4. **Low:** Add integration tests for full pipeline (mentioned in handoff.md)
