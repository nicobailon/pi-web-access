# pi-web-access Bug Report

Tested 2026-05-23. All features systematically tested via manual test suite.

## Summary

| Category | Healthy | Broken | Degraded | Total |
|----------|---------|--------|----------|-------|
| Features | 14 | 4 | 3 | 21 |

---

## ❌ Broken Features

### 1. Local LLM Port Mismatch
- **File:** `local-llm-api.ts`
- **Line:** 12
- **Bug:** `LLM_BASE` is hardcoded to `http://localhost:8082/v1`, but the LLM is running on port 8080
- **Evidence:** `curl http://localhost:8080/v1/chat/completions` works; `curl http://localhost:8082/v1/chat/completions` returns nothing
- **Impact:** All local LLM features (YouTube extraction, video analysis, summarization) fail
- **Fix:** Make port configurable via `~/.pi/web-search.json` or try 8080 as fallback

### 2. Vector DB Schema Mismatch
- **File:** `exa-vector-db.ts`
- **Line:** 35-44
- **Bug:** Code creates table with column `embedding BLOB`, but existing DB has `embedding_binary BLOB`
- **Evidence:** `sqlite3 ~/.pi/exa-vector-db.sqlite ".schema"` shows `embedding_binary`, code uses `embedding`
- **Impact:** All vector DB operations fail with "table documents has no column named embedding"
- **Fix:** Add schema migration to rename `embedding_binary` → `embedding`, or use consistent column name

### 3. GitHub Blob URLs - Case Sensitivity
- **File:** `github-api.ts`
- **Line:** 145-160
- **Bug:** GitHub API is case-sensitive; file path "README.md" fails when actual file is "Readme.md" (expressjs/express)
- **Evidence:** `curl -s "https://api.github.com/repos/expressjs/express/contents/README.md?ref=master"` returns 404; actual file is "Readme.md"
- **Impact:** `fetch_content` returns null for some valid GitHub blob URLs
- **Fix:** Add case-insensitive fallback: when 404, list directory and try matching files

### 4. GitHub Ref Not Fallback to Default Branch
- **File:** `github-api.ts`
- **Line:** 138
- **Bug:** When `info.ref` is set (e.g., "main") but the branch doesn't exist, code doesn't fall back to default branch
- **Evidence:** expressjs/express default branch is "master", URL with "main" ref returns 404 from API
- **Impact:** `fetch_content` fails for GitHub URLs with non-existent branches
- **Fix:** Try default branch as fallback when specified ref returns 404

---

## ⚠️ Degraded Features

### 1. Browser Stealth Error Handling
- **File:** `browser-stealth.ts`
- **Line:** 138-155
- **Issue:** Returns `undefined` content when Chrome is not running, instead of a proper error message
- **Evidence:** `extractViaBrowserStealth` returns `{ content: "", error: undefined }`
- **Impact:** Caller can't distinguish between "no content" and "browser not available"
- **Fix:** Return proper error message when browser is unavailable

### 2. `computeRangeTimestamps` Frame Count for Short Videos
- **File:** `extract.ts`
- **Line:** 148-155
- **Issue:** `MIN_FRAME_INTERVAL = 5` prevents extracting requested number of frames for short videos
- **Evidence:** `computeRangeTimestamps(0, 10, 5)` returns `[0, 5, 10]` (3 frames) instead of 5
- **Impact:** User requests N frames but gets fewer for short videos
- **Fix:** Allow configurable min interval or reduce it

### 3. `exa_pipeline` No Timeout
- **File:** `exa-pipeline.ts`
- **Line:** 100-200
- **Issue:** Pipeline can hang indefinitely during embedding generation or content extraction
- **Evidence:** Test timed out after 120 seconds during embedding generation
- **Impact:** Unresponsive behavior on slow networks or large result sets
- **Fix:** Add overall pipeline timeout (e.g., 180 seconds)

---

## ✅ Healthy Features

1. **`web_search`** - Single query, batch queries, recency filter, domain filter (with caveats)
2. **`fetch_content`** - HTML pages, JSON, text, multiple URLs
3. **GitHub URL parsing** - Root, blob, tree types all parse correctly
4. **YouTube URL detection** - watch, youtu.be, shorts, live, embed, v formats
5. **Local video detection** - MP4, MOV, WebM, AVI formats
6. **Local video frame extraction** - ffmpeg works correctly
7. **YouTube stream info** - yt-dlp works correctly
8. **Storage** - store, retrieve, delete, clear all work
9. **Nomic Embedding** - 256-dim embeddings with proper normalization
10. **Cosine similarity** - Self-similarity = 1.0, different docs < 0.5
11. **Activity monitor** - Log, complete, error tracking works
12. **Utils** - `formatSeconds` works correctly
13. **Browser stealth availability check** - Detects agent-browser-stealth correctly
14. **Firecrawl config** - Loads config correctly

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
- `exaApiKey` — needed for Exa MCP fallback
- `perplexityApiKey` — needed for Perplexity search fallback
- `geminiApiKey` — needed for YouTube/video extraction fallback

### Missing Binaries
- `yt-dlp` — installed, working
- `ffmpeg` — installed, working
- `gh` — installed, working
- `lightpanda` — installed, working

### Local Services
- **LLM on port 8080** — Running (Qwen3.6-35B-A3B)
- **SearXNG on port 8081** — Running
- **Firecrawl on port 3002** — Running
- **Sourcegraph on port 3000** — Not running

---

## Priority Recommendations

1. **Critical:** Fix LLM port mismatch (8082 → 8080 or make configurable)
2. **High:** Fix Vector DB schema migration
3. **High:** Fix GitHub blob case sensitivity
4. **Medium:** Add GitHub ref fallback to default branch
5. **Medium:** Add browser stealth proper error handling
6. **Low:** Add exa_pipeline timeout
7. **Low:** Improve computeRangeTimestamps for short videos
