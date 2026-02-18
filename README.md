<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and video understanding for Pi agent. Zero config with Chrome, or bring your own API keys.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f

## Why Pi Web Access

**Zero Config** — Signed into Google in Chrome? That's it. The extension reads your Chrome session cookies to access Gemini directly. No API keys, no setup, no subscriptions.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain. Search tries Perplexity, then Gemini API, then Gemini Web. YouTube tries Gemini Web, then API, then Perplexity. Blocked pages retry through Jina Reader and Gemini extraction. Something always works.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-web-access
```

If you're not signed into Chrome, or prefer a different provider, add API keys to `~/.pi/web-search.json`:

```json
{
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

You can configure one or both. In `auto` mode (default), `web_search` tries Perplexity first, then Gemini API, then Gemini Web.

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Understand a YouTube video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })

// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Tools

### web_search

Search the web via Perplexity AI or Gemini. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "gemini" })
web_search({ query: "...", includeContent: true })
web_search({ queries: ["query 1", "query 2"], curate: true })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | `auto` (default), `perplexity`, or `gemini` |
| `includeContent` | Fetch full page content from sources in background |
| `curate` | Hold results for browser review (default: true for multi-query). Press Ctrl+S to open browser UI, or wait for countdown to auto-condense and send. Set to false to skip both curation and condensation. |

### fetch_content

Fetch URL(s) and extract readable content as markdown. Automatically detects and handles GitHub repos, YouTube videos, PDFs, local video files, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question to ask about a YouTube video or local video file |
| `timestamp` | Extract frame(s) — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Content over 30,000 chars is truncated in tool responses but stored in full for retrieval here.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://..." })
get_search_content({ responseId: "abc123", query: "original query" })
```

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI.

### YouTube videos

YouTube URLs are processed via Gemini for full video understanding — visual descriptions, transcripts with timestamps, and chapter markers. Pass a `prompt` to ask specific questions about the video. Results include the video thumbnail so the agent gets visual context alongside the transcript.

Fallback: Gemini Web → Gemini API → Perplexity (text summary only). Handles all URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`.

### Local video files

Pass a file path (`/`, `./`, `../`, or `file://` prefix) to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats up to 50MB. Pass a `prompt` to ask about specific content. If ffmpeg is installed, a thumbnail frame is included alongside the analysis.

Fallback: Gemini API (Files API upload) → Gemini Web.

### Video frame extraction

Use `timestamp` and/or `frames` on any YouTube URL or local video file to extract visual frames as images.

```typescript
fetch_content({ url: "...", timestamp: "23:41" })                       // single frame
fetch_content({ url: "...", timestamp: "23:41-25:00" })                 // range, 6 frames
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })      // range, custom count
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })            // 5 frames at 5s intervals
fetch_content({ url: "...", frames: 6 })                                // sample whole video
```

Requires `ffmpeg` (and `yt-dlp` for YouTube). Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs are extracted as text and saved to `~/Downloads/` as markdown. The agent can then `read` specific sections without loading the full document into context. Text-based extraction only — no OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension retries via Jina Reader (handles JS rendering server-side, no API key needed), then Gemini URL Context API, then Gemini Web extraction. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present.

## How It Works

```
fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web → Gemini API → Perplexity
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Jina Reader → Gemini fallback
               → Text/JSON/Markdown? Return directly
```

## Skills

### librarian

Bundled research workflow for investigating open-source libraries. Combines GitHub cloning, web search, and git operations (blame, log, show) to produce evidence-backed answers with permalinks. Pi loads it automatically based on your prompt. Also available via `/skill:librarian` with [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette).

## Commands

### /websearch

Open the search curator directly in the browser. Runs searches and lets you review, add, and select results to send back to the agent — no LLM round-trip needed.

```
/websearch                                    # empty page, type your own searches
/websearch react hooks, next.js caching       # pre-fill with comma-separated queries
```

Results get injected into the conversation when you click Send. The agent sees them and can use them immediately.

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

All config lives in `~/.pi/web-search.json`. Every field is optional.

```json
{
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "provider": "perplexity",
  "curateWindow": 10,
  "autoFilter": true,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  }
}
```

`GEMINI_API_KEY` and `PERPLEXITY_API_KEY` env vars take precedence over config file values. `provider` sets the default search provider: `"perplexity"` or `"gemini"`. This is also updated automatically when you change the provider in the curator UI. `curateWindow` controls how many seconds multi-query searches wait before auto-sending results (default: 10). During the countdown, press Ctrl+S to open the browser curator. Set to 0 to always send immediately (Ctrl+S still works during the search itself).

### Auto-Condense

Multi-query searches are automatically condensed into a deduplicated briefing when the countdown expires without Ctrl+S. A single LLM call receives all search results — enriched with preprocessing analysis (URL overlap, answer similarity, source quality tiers) — and produces a concise synthesis organized by topic. Irrelevant or off-topic results are skipped automatically.

```json
{
  "autoFilter": {
    "enabled": true,
    "model": "anthropic/claude-haiku-4-5",
    "prompt": "You are a research assistant..."
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | `true` to enable, `false` to disable. Omit `autoFilter` entirely to enable with defaults. |
| `model` | LLM model in `provider/model` format. Uses pi's model registry for auth. Default: `anthropic/claude-haiku-4-5`. |
| `prompt` | System prompt for the condenser. Should instruct the model to synthesize, deduplicate, and cite sources. Omit to use the built-in prompt. |

Shorthand: `"autoFilter": true` or `"autoFilter": false` for enable/disable without customizing model or prompt.

The model uses pi's model registry, so any configured provider works — including custom gateways, OAuth tokens, and API keys. If the model isn't found in the registry or has no credentials, condensation is silently skipped.

The `web_search` tool also accepts an optional `context` parameter — a brief description of the user's current task or goal. When provided, the condenser uses it to focus the briefing (e.g., "building a Shopify checkout extension" helps it emphasize relevant findings over general noise).

Set `"enabled": false` under any feature to disable it. Config changes require a Pi restart.

Rate limits: Perplexity is capped at 10 requests/minute (client-side). Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- Chrome cookie extraction works on macOS and Linux (GNOME Keyring via `secret-tool`, with fallback to default password). Windows requires API keys. First-time access on macOS may trigger a Keychain dialog.
- On Linux, supports both Chromium and Google Chrome. Requires `libsecret` (`secret-tool` CLI) for keyring access.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `curator-page.ts` | HTML/CSS/JS generation for the curator UI with markdown rendering |
| `curator-server.ts` | Ephemeral HTTP server with SSE streaming and state machine |
| `search-filter.ts` | Auto-condense pipeline — preprocessing, LLM condensation, and post-processing for multi-query results |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `gemini-search.ts` | Search routing across Perplexity, Gemini API, Gemini Web |
| `gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-api.ts` | Gemini REST API client (generateContent) |
| `chrome-cookies.ts` | Chrome/Chromium cookie extraction (macOS Keychain, Linux GNOME Keyring) |
| `youtube-extract.ts` | YouTube detection, three-tier extraction, frame extraction |
| `video-extract.ts` | Local video detection, Files API upload, Gemini analysis |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `perplexity.ts` | Perplexity API client with rate limiting |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `utils.ts` | Shared formatting and error helpers |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |
| `skills/librarian/` | Bundled skill for library research |

</details>
