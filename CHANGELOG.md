# Pi Web Access - Changelog

All notable changes to this project will be documented in this file.

## [0.10.2] - 2026-02-18

### Added
- **Interactive search curation.** Press Ctrl+Shift+S during or after a multi-query search to open a browser-based review UI. Results stream in live via SSE. Pick which queries to keep, add new searches on the fly, switch providers — then submit to send only the curated results to the agent.
- **Auto-condense pipeline.** When the countdown expires without manual curation, a single LLM call (Claude Haiku by default) condenses all search results into a deduplicated briefing organized by topic. Preprocessing enriches the prompt with URL overlap, answer similarity, and source quality analysis. Configure via `"autoFilter"` in `~/.pi/web-search.json`. Full uncondensed results stored and retrievable via `get_search_content`.
- **Configurable keyboard shortcuts.** Both shortcuts (curate: Ctrl+Shift+S, activity monitor: Ctrl+Shift+W) can be remapped via `"shortcuts"` in `~/.pi/web-search.json`. Changes take effect on restart.
- **`/websearch` command** — opens the curator directly from pi without an agent round-trip. Accepts optional comma-separated queries or opens empty.
- **Task-aware condensation.** Optional `context` parameter on `web_search` — a brief description of the user's task. The condenser uses it to focus the briefing on what matters.
- **Provider selection** — global dropdown in the curator UI to switch between Perplexity and Gemini. Persists to `~/.pi/web-search.json`.
- **Live condense status in countdown.** Shows "condensing..." while the LLM is working, then "N searches condensed" once complete.
- Markdown rendering in curator result cards via marked.js.
- Query-level result cards with expandable answers and source lists. Check/uncheck to include or exclude.
- SSE streaming with keepalive, socket health checks, and buffered delivery.
- Idle-based timer (60s default, adjustable). Timeout sends all results as safe default.
- Keyboard shortcuts: Enter (submit), Escape (skip), A (toggle all).
- Dark/light theme via `prefers-color-scheme` with teal accent palette.

### Changed
- **Curate enabled by default.** Multi-query searches show a 10-second review window; single queries send immediately. Pass `curate: false` to opt out.
- **Curate shortcut opens browser immediately, even mid-search.** Remaining results stream in live via SSE.
- **Tool descriptions encourage multi-query research.** The `queries` param explains how to vary phrasing and scope across 2-4 queries, with good/bad examples.
- **Curated results instruct the LLM.** Tool output prefixed with an instruction telling the LLM to use curated results as-is.
- Expanded view shows full answer text per query with source titles and domains.
- Non-curated `web_search` calls now respect the saved provider preference.
- Config helpers generalized from `loadSavedProvider`/`saveProvider` to `loadConfig`/`saveConfig`.

### Fixed
- Curated `onSubmit` passed the original full query list instead of the filtered list, inflating `queryCount`.
- Collapsed curated status mixed source URL counts with query counts.

### New files
- `curator-server.ts` — ephemeral HTTP server with SSE streaming, state machine, heartbeat watchdog, and token auth.
- `curator-page.ts` — HTML/CSS/JS for the curator UI with markdown rendering and overlay transitions.
- `search-filter.ts` — auto-condense pipeline: preprocessing, LLM condensation via pi's model registry, and post-processing (citation verification, source list completion).

## [0.7.3] - 2026-02-05

### Added
- Jina Reader fallback for JS-rendered pages. When Readability returns insufficient content (cookie notices, consent walls, SPA shells), the extraction chain now tries Jina Reader (`r.jina.ai`) before falling back to Gemini. Jina handles JavaScript rendering server-side and returns clean markdown. No API key required.
- JS-render detection heuristic (`isLikelyJSRendered`) produces more specific error messages when pages appear to load content dynamically.
- Actionable guidance when all extraction methods fail, listing steps to configure Gemini API or use `web_search` instead.

### Changed
- HTTP fetch headers now mimic Chrome (realistic `User-Agent`, `Sec-Fetch-*`, `Accept-Language`) instead of the default Node.js user agent. Reduces blocks from bot-detection systems.
- Short Readability output (< 500 chars) is now treated as a content failure, triggering the fallback chain. Previously, a 266-char cookie notice was returned as "successful" content.
- Extraction fallback order is now: HTTP+Readability → RSC → Jina Reader → Gemini URL Context → Gemini Web → error with guidance.

### Fixed
- `parseTimestamp` now rejects negative values in colon-separated format (`-1:30`, `1:-30`). Previously only the numeric path (`-90`) rejected negatives, while the colon path computed and returned negative seconds.

## [0.7.2] - 2026-02-03

### Added
- `model` parameter on `fetch_content` to override the Gemini model per-request (e.g. `model: "gemini-2.5-flash"`)
- Collapsed TUI results now show a 200-char text preview instead of just the status line
- LICENSE file (MIT)

### Changed
- Default Gemini model updated from `gemini-2.5-flash` to `gemini-3-flash-preview` across all API, search, URL context, YouTube, and video paths. Gemini Web gracefully falls back to `gemini-2.5-flash` when the model header isn't available.
- README rewritten: added tagline, badges, "Why" section, Quick Start, corrected "How It Works" routing order, fixed inaccurate env var precedence claim, added missing `/v/` YouTube format, restored `/search` command docs, collapsible Files table

### Fixed
- `PERPLEXITY_API_KEY` env var now takes precedence over config file value, matching `GEMINI_API_KEY` behavior and README documentation (was reversed)
- `package.json` now includes `repository`, `homepage`, `bugs`, and `description` fields (repo link was missing from pi packages site)

## [0.7.0] - 2026-02-03

### Added
- **Multi-provider web search**: `web_search` now supports Perplexity, Gemini API (with Google Search grounding), and Gemini Web (cookie auth) as search providers. New `provider` parameter (`auto`, `perplexity`, `gemini`) controls selection. In `auto` mode (default): Perplexity → Gemini API → Gemini Web. Backwards-compatible — existing Perplexity users see no change.
- **Gemini API grounded search**: Structured citations via `groundingMetadata` with source URIs and text-to-source mappings. Google proxy URLs are resolved via HEAD redirects. Configured via `GEMINI_API_KEY` or `geminiApiKey` in config.
- **Gemini Web search**: Zero-config web search for users signed into Google in Chrome. Prompt instructs Gemini to cite sources; URLs extracted from markdown response.
- **Gemini extraction fallback**: When `fetch_content` fails (HTTP 403/429, Readability fails, network errors), automatically retries via Gemini URL Context API then Gemini Web extraction. Each has an independent 60s timeout. Handles SPAs, JS-heavy pages, and anti-bot protections.
- **Local video file analysis**: `fetch_content` accepts file paths to video files (MP4, MOV, WebM, AVI, etc.). Detected by path prefix (`/`, `./`, `../`, `file://`), validated by extension and 50MB limit. Two-tier fallback: Gemini API (resumable upload via Files API with proper MIME types, poll-until-active and cleanup) → Gemini Web (free, cookie auth).
- **Video prompt parameter**: `fetch_content` gains optional `prompt` parameter for asking specific questions about video content. Threads through YouTube and local video extraction. Without prompt, uses default extraction (transcript + visual descriptions).
- **Video thumbnails**: YouTube results include the video thumbnail (fetched from `img.youtube.com`). Local video results include a frame extracted via ffmpeg (at ~1 second). Returned as image content parts alongside text — the agent sees the thumbnail as vision context.
- **Configurable frame extraction**: `frames` parameter (1-12) on `fetch_content` for pulling visual frames from YouTube or local video. Works in five modes: frames alone (sample across entire video), single timestamp (one frame), single+frames (N frames at 5s intervals), range (default 6 frames), range+frames (N frames across the range). Endpoint-inclusive distribution with 5-second minimum spacing.
- **Video duration in responses**: Frame extraction results include the video duration for context.
- `searchProvider` config option in `~/.pi/web-search.json` for global provider default
- `video` config section: `enabled`, `preferredModel`, `maxSizeMB`

### Changed
- `PerplexityResponse` renamed to `SearchResponse` (shared interface for all search providers)
- Extracted HTTP pipeline from `extractContent` into `extractViaHttp` for cleaner Gemini fallback orchestration
- `getApiKey()`, `API_BASE`, `DEFAULT_MODEL` exported from `gemini-api.ts` for use by search and URL Context modules
- `isPerplexityAvailable()` added to `perplexity.ts` as non-throwing API key check
- Content-type routing in `extract.ts`: only `text/html` and `application/xhtml+xml` go through Readability; all other text types (`text/markdown`, `application/json`, `text/csv`, etc.) returned directly. Fixes the OpenAI cookbook `.md` URL that returned "Untitled (30 chars)".
- Title extraction for non-HTML content: `extractTextTitle()` pulls from markdown `#`/`##` headings, falls back to URL filename
- Combined `yt-dlp --print duration -g` call fetches stream URL and duration in a single invocation, reused across all frame extraction paths via `streamInfo` passthrough
- Shared helpers in `utils.ts` (`formatSeconds`, error mapping) eliminate circular imports and duplication across youtube-extract.ts and video-extract.ts

### Fixed
- `fetch_content` TUI rendered `undefined/undefined URLs` during progress updates (renderResult didn't handle `isPartial`, now shows a progress bar like `web_search` does)
- RSC extractor produced malformed markdown for `<pre><code>` blocks (backticks inside fenced code blocks) -- extremely common on Next.js documentation pages
- Multi-URL fetch failures rendered in green "success" color even when 0 URLs succeeded (now red)
- `web_search` queries parameter described as "parallel" in schema but execution is sequential (changed to "batch"; `urls` correctly remains "parallel")
- Proper error propagation for frame extraction: missing binaries (yt-dlp, ffmpeg, ffprobe), private/age-restricted/region-blocked videos, expired stream URLs (403), timestamp-exceeds-duration, and timeouts all produce specific user-facing messages instead of silent nulls
- `isTimeoutError` now detects `execFileSync` timeouts via the `killed` flag (SIGTERM from timeout was previously unrecognized)
- Float video durations (e.g. 15913.7s from yt-dlp) no longer produce out-of-range timestamps — durations are floored before computing frame positions
- `parseTimestamp` consistently floors results across both bare-number ("90.5" → 90) and colon ("1:30.5" → 90) paths — previously the colon path returned floats
- YouTube thumbnail assignment no longer sets `null` on the optional `thumbnail` field when fetch fails (was a type mismatch; now only assigned on success)

### New files
- `gemini-search.ts` -- search routing + Gemini Web/API search providers with grounding
- `gemini-url-context.ts` -- URL Context API extraction + Gemini Web extraction fallback
- `video-extract.ts` -- local video file detection, Gemini Web/API analysis with Files API upload
- `utils.ts` -- shared formatting and error helpers for frame extraction

## [0.6.0] - 2026-02-02

### Added
- YouTube video understanding in `fetch_content` via three-tier fallback chain:
  - **Gemini Web** (primary): reads Chrome session cookies from macOS Keychain + SQLite, authenticates to gemini.google.com, sends YouTube URL via StreamGenerate endpoint. Full visual + audio understanding with timestamps. Zero config needed if signed into Google in Chrome.
  - **Gemini API** (secondary): direct REST calls with `GEMINI_API_KEY`. YouTube URLs passed as `file_data.file_uri`. Configure via `GEMINI_API_KEY` env var or `geminiApiKey` in `~/.pi/web-search.json`.
  - **Perplexity** (fallback): uses existing `searchWithPerplexity` for a topic summary when neither Gemini path is available. Output labeled as "Summary (via Perplexity)" so the agent knows it's not a full transcript.
- YouTube URL detection for all common formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`, `m.youtube.com`
- Configurable via `~/.pi/web-search.json` under `youtube` key (`enabled`, `preferredModel`)
- Actionable error messages when extraction fails (directs user to sign into Chrome or set API key)
- YouTube URLs no longer fall through to HTTP/Readability (which returns garbage); returns error instead

### New files
- `chrome-cookies.ts` -- macOS Chrome cookie extraction using Node builtins (`node:crypto`, `node:sqlite`, `child_process`)
- `gemini-web.ts` -- Gemini Web client ported from surf's gemini-client.cjs (cookie auth, StreamGenerate, model fallback)
- `gemini-api.ts` -- Gemini REST API client (generateContent, file upload/processing/cleanup for Phase 2)
- `youtube-extract.ts` -- YouTube extraction orchestrator with three-tier fallback and activity logging

## [0.5.1] - 2026-02-02

### Added
- Bundled `librarian` skill -- structured research workflow for open-source libraries with GitHub permalinks, combining fetch_content (cloning), web_search (recent info), and git operations (blame, log, show)

### Fixed
- Session fork event handler was registered as `session_branch` (non-existent event) instead of `session_fork`, meaning forks never triggered cleanup (abort pending fetches, clear clone cache, restore session data)
- API fallback title for tree URLs with a path (e.g. `/tree/main/src`) now includes the path (`owner/repo - src`), consistent with clone-based results
- Removed unnecessary export on `getDefaultBranch` (only used internally by `fetchViaApi`)

## [0.5.0] - 2026-02-01

### Added
- GitHub repository clone extraction for `fetch_content` -- detects GitHub code URLs, clones repos to `/tmp/pi-github-repos/`, and returns actual file contents plus local path for further exploration with `read` and `bash`
- Lightweight API fallback for oversized repos (>350MB) and commit SHA URLs via `gh api`
- Clone cache with concurrent request deduplication (second request awaits first's clone)
- `forceClone` parameter on `fetch_content` to override the size threshold
- Configurable via `~/.pi/web-search.json` under `githubClone` key (enabled, maxRepoSizeMB, cloneTimeoutSeconds, clonePath)
- Falls back to `git clone` when `gh` CLI is unavailable (public repos only)
- README: GitHub clone documentation with config, flow diagram, and limitations

### Changed
- Refactored `extractContent`/`fetchAllContent` signatures from positional `timeoutMs` to `ExtractOptions` object
- Blob/tree fetch titles now include file path (e.g. `owner/repo - src/index.ts`) for better disambiguation in multi-URL results and TUI

### Fixed
- README: Activity monitor keybinding corrected from `Ctrl+Shift+O` to `Ctrl+Shift+W`

## [0.4.5] - 2026-02-01

### Changed
- Added package keywords for npm discoverability

## [0.4.4] - 2026-02-01

### Fixed
- Adapt execute signatures to pi v0.51.0: reorder signal, onUpdate, ctx parameters across all three tools

## [0.4.3] - 2026-01-27

### Fixed
- Google API compatibility: Use `StringEnum` for `recencyFilter` to avoid unsupported `anyOf`/`const` JSON Schema patterns

## [0.4.2] - 2026-01-27

### Fixed

- Single-URL fetches now store content for retrieval via `get_search_content` (previously only multi-URL)
- Corrected `get_search_content` usage syntax in fetch_content help messages

### Changed

- Increased inline content limit from 10K to 30K chars (larger content truncated but fully retrievable)

### Added

- Banner image for README

## [0.4.1] - 2026-01-26

### Changed
- Added `pi` manifest to package.json for pi v0.50.0 package system compliance
- Added `pi-package` keyword for npm discoverability

## [0.4.0] - 2026-01-19

### Added

- PDF extraction via `unpdf` - fetches PDFs from URLs and saves as markdown to `~/Downloads/`
  - Extracts text, metadata (title, author), page count
  - Supports PDFs up to 20MB (vs 5MB for HTML)
  - Handles arxiv URLs with smart title fallback

### Fixed

- Plain text URL detection now uses hostname check instead of substring match

## [0.3.0] - 2026-01-19

### Added

- RSC (React Server Components) content extraction for Next.js App Router pages
  - Parses flight data from `<script>self.__next_f.push([...])</script>` tags
  - Reconstructs markdown with headings, tables, code blocks, links
  - Handles chunk references and nested components
  - Falls back to RSC extraction when Readability fails
- Content-type validation rejects binary files (images, PDFs, audio, video, zip)
- 5MB response size limit (checked via Content-Length header) to prevent memory issues

### Fixed

- `fetch_content` now handles plain text URLs (raw.githubusercontent.com, gist.githubusercontent.com, any text/plain response) instead of failing with "Could not extract readable content"

## [0.2.0] - 2026-01-11

### Added

- Activity monitor widget (`Ctrl+Shift+O`) showing live request/response activity
  - Displays last 10 API calls and URL fetches with status codes and timing
  - Shows rate limit usage and reset countdown
  - Live updates as requests complete
  - Auto-clears on session switch

### Changed

- Refactored activity tracking into dedicated `activity.ts` module

## [0.1.0] - 2026-01-06

Initial release. Designed for pi v0.37.3.

### Added

- `web_search` tool - Search via Perplexity AI with synthesized answers and citations
  - Single or batch queries (parallel execution)
  - Recency filter (day/week/month/year)
  - Domain filter (include or exclude)
  - Optional async content fetching with agent notification
- `fetch_content` tool - Fetch and extract readable content from URLs
  - Single URL returns content directly
  - Multiple URLs store for retrieval via `get_search_content`
  - Concurrent fetching (3 max) with 30s timeout
- `get_search_content` tool - Retrieve stored search results or fetched content
  - Access by response ID, URL, query, or index
- `/search` command - Interactive browser for stored results
- TUI rendering with progress bars, URL lists, and expandable previews
- Session-aware storage with 1-hour TTL
- Rate limiting (10 req/min for Perplexity API)
- Config file support (`~/.pi/web-search.json`)
- Content extraction via Readability + Turndown (max 10k chars)
- Proper session isolation - pending fetches abort on session switch
- URL validation before fetch attempts
- Defensive JSON parsing for API responses
