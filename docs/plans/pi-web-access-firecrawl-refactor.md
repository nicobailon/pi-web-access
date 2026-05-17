# Pi Web Access — Firecrawl Refactor Plan

**Created:** 2026-05-17  
**Status:** active  
**Type:** software-refactor

## Goal

Replace Gemini API + Tavily MCP with Firecrawl for web search and content extraction, and replace Gemini cookie-based browser access with agent-browser-stealth CLI, while maintaining full existing functionality (YouTube, video, PDF, GitHub extraction, readability parsing).

## Problem Frame

The extension currently depends on:
- **Gemini API** (`gemini-api.ts`) — web search grounding, URL context extraction, video analysis
- **Gemini Web** (`gemini-web.ts`) — cookie-based browser authentication for Gemini
- **Tavily MCP** — web search provider (to be removed entirely)

These dependencies are being replaced with:
- **Firecrawl** — web search (`firecrawl_search`) and URL scraping (`firecrawl_scrape`)
- **agent-browser-stealth** — undetectable browser automation for cookie access and anti-bot bypass

## Architecture Decision

### Firecrawl Invocation Strategy

Firecrawl is available as a Pi MCP tool (`@benvargas/pi-firecrawl`) but the extension runs as a standalone Node.js module. The extension will call Firecrawl's REST API directly (`https://api.firecrawl.dev/v1/search` and `/v1/scrape`), requiring the user to set `FIRECRAWL_API_KEY` in `~/.pi/web-search.json`. This is the same pattern already used by the `@benvargas/pi-firecrawl` extension itself.

### Browser Automation Strategy

`gemini-web.ts` (cookie extraction + Gemini API calls) is replaced by `browser-stealth.ts` which uses the `agent-browser-stealth` CLI to:
1. Navigate to gemini.google.com and extract session cookies (for Gemini Web fallback)
2. Scrape anti-bot protected pages that block standard HTTP

### Provider Fallback Chain (New)

**Search:** Exa → Perplexity → Firecrawl → agent-browser-stealth (Gemini Web)  
**Content Extraction:** HTTP + Readability → Firecrawl scrape → Jina Reader → agent-browser-stealth → Gemini Web (cookie)

## Tasks

### Phase 1: New Module Creation

#### 1.1 Create `firecrawl-config.ts`
- **File:** `firecrawl-config.ts` (new)
- **Purpose:** Centralized Firecrawl configuration (API key, base URL, timeout)
- **Changes:** Reads from `~/.pi/web-search.json` field `firecrawlApiKey` and `firecrawlBaseUrl`. Also checks `FIRECRAWL_API_KEY` env var.
- **Exports:** `getFirecrawlConfig()`, `isFirecrawlAvailable()`, `FirecrawlConfig` interface

#### 1.2 Create `firecrawl-search.ts`
- **File:** `firecrawl-search.ts` (new)
- **Purpose:** Web search via Firecrawl's `/v1/search` endpoint
- **Changes:**
  - Imports `firecrawl-config.ts`
  - Implements `searchWithFirecrawl(query, options)` → returns `AttributedSearchResponse`
  - Maps Firecrawl response format (`links[]`, `markdown`) to the extension's `SearchResult[]` + answer format
  - Handles `recencyFilter` and `domainFilter` via Firecrawl query parameters

#### 1.3 Create `firecrawl-fetch.ts`
- **File:** `firecrawl-fetch.ts` (new)
- **Purpose:** URL content extraction via Firecrawl's `/v1/scrape` endpoint
- **Changes:**
  - Imports `firecrawl-config.ts`
  - Implements `extractWithFirecrawl(url, signal)` → returns `ExtractedContent | null`
  - Uses `formats: ["markdown"]` and `onlyMainContent: true` for clean extraction

#### 1.4 Create `browser-stealth.ts`
- **File:** `browser-stealth.ts` (new)
- **Purpose:** agent-browser-stealth CLI wrapper for undetectable browser access
- **Changes:**
  - Implements `stealthNavigate(url)`, `stealthSnapshot(options)`, `stealthText(selector)`, `stealthPageContent()`, `stealthCookieExtract()`
  - Uses `execFileSync` or `exec` for CLI calls
  - Handles `--launch` flag fallback when Chrome CDP is unavailable

#### 1.5 Create `browser-config.ts` (renamed from gemini-web-config.ts)
- **File:** `browser-config.ts` (new)
- **Purpose:** Browser stealth configuration
- **Changes:** Replace `allowBrowserCookies` with `browserStealthEnabled`, replace `chromeProfile` with `stealthLaunchMode`

### Phase 2: Refactor Existing Modules

#### 2.1 Refactor `gemini-api.ts`
- **File:** `gemini-api.ts`
- **Changes:** Remove search-related code, keep `queryGeminiApiWithVideo()` for video analysis

#### 2.2 Refactor `extract.ts`
- **File:** `extract.ts`
- **Changes:** Update imports, add Firecrawl + browser-stealth fallback chain

#### 2.3 Refactor `youtube-extract.ts`
- **File:** `youtube-extract.ts`
- **Changes:** Replace `tryGeminiWeb()` with `tryBrowserStealth()`

#### 2.4 Refactor `video-extract.ts`
- **File:** `video-extract.ts`
- **Changes:** Replace `tryVideoGeminiWeb()` with `tryBrowserStealthVideo()`

#### 2.5 Refactor `index.ts`
- **File:** `index.ts`
- **Changes:** Update providers, tool descriptions, imports, replace `google-account` command

### Phase 3: Remove Tavily MCP

#### 3.1 Remove Tavily from MCP config
- **File:** `~/.config/mcp/mcp.json` — already clean (no Tavily entries)

#### 3.2 Remove Tavily from package.json
- **File:** `package.json` — remove `tavily-mcp` from dependencies

#### 3.3 Remove Tavily from index.ts
- **File:** `index.ts` — remove Tavily provider references

### Phase 4: Cleanup

#### 4.1 Delete old modules
- `gemini-search.ts`, `gemini-url-context.ts`, `gemini-web.ts`, `gemini-web-config.ts`

#### 4.2 Update `README.md`
- Update all references to reflect new architecture

## Files to Modify

| File | Action |
|------|--------|
| `firecrawl-config.ts` | NEW |
| `firecrawl-search.ts` | NEW |
| `firecrawl-fetch.ts` | NEW |
| `browser-stealth.ts` | NEW |
| `browser-config.ts` | NEW |
| `gemini-api.ts` | MODIFY |
| `extract.ts` | MODIFY |
| `youtube-extract.ts` | MODIFY |
| `video-extract.ts` | MODIFY |
| `index.ts` | MODIFY |
| `package.json` | MODIFY |
| `README.md` | MODIFY |

## Files to Delete

| File |
|------|
| `gemini-search.ts` |
| `gemini-url-context.ts` |
| `gemini-web.ts` |
| `gemini-web-config.ts` |

## Dependencies

- **Firecrawl API key** (`FIRECRAWL_API_KEY` or `firecrawlApiKey` in config)
- **agent-browser-stealth CLI** (`agent-browser-stealth` or `abs` command)
- **Chrome with CDP enabled** (fallback: `--launch` mode)
- **yt-dlp + ffmpeg** (unchanged, for video frame extraction)

## Risks

1. **Firecrawl API key required** — Users without key lose Firecrawl; Exa/Perplexity remain available
2. **Chrome CDP not available** — `--launch` mode as fallback
3. **YouTube extraction changes** — Keep Gemini API as first fallback
4. **Breaking provider enum change** — Map `"gemini"` → `"firecrawl"` as alias
5. **Gemini API still needed for video** — Keep `gemini-api.ts` for video only

## Execution Order

1. Create new modules (firecrawl-config, firecrawl-search, firecrawl-fetch, browser-stealth, browser-config)
2. Refactor gemini-api.ts (remove search, keep video)
3. Refactor extract.ts (update imports, add new fallback chain)
4. Refactor youtube-extract.ts (replace Gemini Web)
5. Refactor video-extract.ts (replace Gemini Web)
6. Refactor index.ts (update providers, tool descriptions)
7. Delete old modules
8. Update README.md
9. Update package.json (remove Tavily)
