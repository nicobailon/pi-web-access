<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

An extension for [Pi coding agent](https://github.com/badlogic/pi-mono/) that gives Pi web capabilities: search via Perplexity AI or Gemini, fetch and extract content from URLs, clone GitHub repos for local exploration, read PDFs, understand YouTube videos, and analyze local video files.

```typescript
web_search({ query: "TypeScript best practices 2025" })
fetch_content({ url: "https://docs.example.com/guide" })
```

## Install

```bash
pi install npm:pi-web-access
```

Configure at least one search provider:

```bash
# Option 1: Sign into gemini.google.com in Chrome (free, zero config)

# Option 2: Gemini API key
echo '{"geminiApiKey": "AIza..."}' > ~/.pi/web-search.json

# Option 3: Perplexity API key
echo '{"perplexityApiKey": "pplx-..."}' > ~/.pi/web-search.json
```

All three work simultaneously. In `auto` mode (default), the extension tries Perplexity first, then Gemini API, then Gemini Web.

**Requires:** Pi v0.37.3+

**Optional dependencies** for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube frame extraction (stream URL + duration lookup)
```

Without these, video content analysis (transcripts via Gemini) still works. The binaries are only needed for extracting visual frames from videos. `ffprobe` (bundled with ffmpeg) is used for local video duration lookup when sampling frames across an entire video.

## Tools

### web_search

Search the web via Perplexity AI or Gemini. Returns synthesized answer with source citations.

```typescript
// Single query
web_search({ query: "rust async programming" })

// Multiple queries (batch)
web_search({ queries: ["query 1", "query 2"] })

// With options
web_search({
  query: "latest news",
  numResults: 10,              // Default: 5, max: 20
  recencyFilter: "week",       // day, week, month, year
  domainFilter: ["github.com"] // Prefix with - to exclude
})

// Explicit provider
web_search({ query: "...", provider: "gemini" })  // auto, perplexity, gemini

// Fetch full page content (async)
web_search({ query: "...", includeContent: true })
```

When `includeContent: true`, sources are fetched in the background. Agent receives notification when ready.

Provider selection in `auto` mode: Perplexity (if key configured) → Gemini API (if key configured, uses Google Search grounding) → Gemini Web (if signed into Chrome). Gemini API returns structured citations with source mappings. Gemini Web returns markdown with embedded links.

### fetch_content

Fetch URL(s) and extract readable content as markdown.

```typescript
// Single URL - returns content directly (also stored for retrieval)
fetch_content({ url: "https://example.com/article" })

// Multiple URLs - returns summary (content stored for retrieval)
fetch_content({ urls: ["url1", "url2", "url3"] })

// PDFs - extracted and saved to ~/Downloads/
fetch_content({ url: "https://arxiv.org/pdf/1706.03762" })
// → "PDF extracted and saved to: ~/Downloads/arxiv-170603762.md"
```

**GitHub repos:** GitHub code URLs are automatically detected and cloned locally instead of scraping HTML. The agent gets actual file contents and a local path to explore with `read` and `bash`.

```typescript
// Clone a repo - returns structure + README
fetch_content({ url: "https://github.com/owner/repo" })
// → "Repository cloned to: /tmp/pi-github-repos/owner/repo"

// Specific file - returns file contents
fetch_content({ url: "https://github.com/owner/repo/blob/main/src/index.ts" })

// Directory - returns listing
fetch_content({ url: "https://github.com/owner/repo/tree/main/src" })

// Force-clone a large repo that exceeds the size threshold
fetch_content({ url: "https://github.com/big/repo", forceClone: true })
```

Repos over 350MB get a lightweight API-based view instead of a full clone. Commit SHA URLs are also handled via the API. Clones are cached for the session -- multiple files from the same repo share one clone, but clones are wiped on session change/shutdown and re-cloned as needed.

**YouTube videos:** YouTube URLs are automatically detected and processed via Gemini for full video understanding (visual + audio + transcript). Three-tier fallback:

```typescript
// Returns transcript with timestamps, visual descriptions, chapter markers
fetch_content({ url: "https://youtube.com/watch?v=dQw4w9WgXcQ" })

// Ask a specific question about the video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are imported?" })
```

1. **Gemini Web** (primary) -- reads your Chrome session cookies. Zero config if you're signed into Google.
2. **Gemini API** (secondary) -- uses `GEMINI_API_KEY` env var or `geminiApiKey` in config.
3. **Perplexity** (fallback) -- topic summary when neither Gemini path is available.

YouTube results include the video thumbnail as an image content part, so the agent receives visual context alongside the transcript.

Handles all YouTube URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`, `m.youtube.com`. Playlist-only URLs fall through to normal extraction.

**Local video files:** Pass a file path to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats. Max 50MB (configurable).

```typescript
// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4" })

// Ask about specific content in the video
fetch_content({ url: "./demo.mov", prompt: "What error message appears on screen?" })
```

Two-tier fallback: Gemini API (needs key, proper Files API with MIME types) → Gemini Web (free, needs Chrome login). File paths are detected by prefix (`/`, `./`, `../`, `file://`). If ffmpeg is installed, a frame from the video is included as a thumbnail image alongside the analysis.

**Video frame extraction (YouTube + local):** Use `timestamp` and/or `frames` to pull visuals for scanning.

```typescript
// Single frame at an exact time
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41" })

// Range scan (default 6 frames)
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00" })

// Custom density across a range
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 3 })

// N frames at 5s intervals starting from a single timestamp
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41", frames: 5 })

// Whole-video sampling (no timestamp)
fetch_content({ url: "https://youtube.com/watch?v=abc", frames: 6 })
```

The same `timestamp`/`frames` syntax works with local file paths (e.g. `/path/to/video.mp4`).

Requirements: YouTube frame extraction needs `yt-dlp` + `ffmpeg`. Local video frames need `ffmpeg` (and `ffprobe`, bundled with ffmpeg, for whole-video sampling).

Common errors include missing binaries, private/age-restricted videos, region blocks, live streams, expired stream URLs (403), and timestamps beyond the video duration.

**Gemini extraction fallback:** When Readability fails or a site blocks bot traffic (403, 429), the extension automatically retries via Gemini URL Context (API) or Gemini Web. This handles SPAs, JS-heavy pages, and anti-bot protections that the HTTP pipeline can't.

**PDF handling:** When fetching a PDF URL, the extension extracts text and saves it as a markdown file in `~/Downloads/`. The agent can then use `read` to access specific sections without loading 200K+ chars into context.

### get_search_content

Retrieve stored content from previous searches or fetches.

```typescript
// By response ID (from web_search or fetch_content)
get_search_content({ responseId: "abc123", urlIndex: 0 })

// By URL
get_search_content({ responseId: "abc123", url: "https://..." })

// By query (for search results)
get_search_content({ responseId: "abc123", query: "original query" })
```

## Features

### Activity Monitor (Ctrl+Shift+W)

Toggle live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
  GET  news.example.com/latest         ...    1.2s ⋯
────────────────────────────────────────────────────────────
Rate: 3/10 (resets in 42s)
```

### RSC Content Extraction

Next.js App Router pages embed content as RSC (React Server Components) flight data in script tags. When Readability fails, the extension parses these JSON payloads directly, reconstructing markdown with headings, tables, code blocks, and links.

### TUI Rendering

Tool calls render with real-time progress:

```
┌─ search "TypeScript best practices 2025" ─────────────────────────┐
│ [████████░░] searching                                            │
└───────────────────────────────────────────────────────────────────┘
```

## Skills

Skills are bundled with the extension and available automatically after install -- no extra setup needed.

### librarian

Structured research workflow for open-source libraries with evidence-backed answers and GitHub permalinks. Loaded automatically when the task involves understanding library internals, finding implementation details, or tracing code history.

Combines `fetch_content` (GitHub cloning), `web_search` (recent info), and git operations (blame, log, show). Pi auto-detects when to load it based on your prompt. If you have [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette) installed, you can also load it explicitly via `/skill:librarian`.

## Commands

### /search

Browse stored search results interactively.

## How It Works

### fetch_content routing

```
fetch_content(url_or_path, prompt?)
       │
       ├── Local video file? ──→ Gemini API → Gemini Web
       │                              ↓
       │                         Video analysis (prompt forwarded)
       │
       ├── github.com code URL? ──→ Clone repo (gh/git --depth 1)
       │                                    │
       │                            ┌───────┼───────┐
       │                            ↓       ↓       ↓
       │                          root    tree     blob
       │                            ↓       ↓       ↓
       │                         tree +   dir     file
       │                         README  listing  contents
       │                            │       │       │
       │                            └───────┼───────┘
       │                                    ↓
       │                           Return content + local
       │                           path for read/bash
       │
       ├── YouTube URL? ──→ Gemini Web → Gemini API → Perplexity
       │                         ↓              (prompt forwarded)
       │                    Transcript + visual descriptions
       │
       ├── PDF? ──→ unpdf → Save to ~/Downloads/
       │
       ├── Plain text/markdown/JSON? ──→ Return directly
       │
       └── HTML ──→ Readability → Markdown
                         │
                    [if fails]
                         ↓
                    RSC Parser → Markdown
                         │
                    [if all fail]
                         ↓
                    Gemini URL Context → Gemini Web extraction
```

### web_search routing

```
web_search(query, provider?)
       │
       ├── provider = "perplexity" ──→ Perplexity API
       ├── provider = "gemini"     ──→ Gemini API → Gemini Web
       └── provider = "auto"
              ├── Perplexity key? ──→ Perplexity API
              ├── Gemini API key? ──→ Gemini API (grounded search)
              ├── Chrome cookies? ──→ Gemini Web (grounded search)
              └── Error
```

When `includeContent: true`, sources are fetched in the background using the fetch_content routing above, and the agent receives a notification when ready.

## Configuration

All config lives in `~/.pi/web-search.json`:

```json
{
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "searchProvider": "auto",
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-2.5-flash"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-2.5-flash",
    "maxSizeMB": 50
  }
}
```

All fields are optional. `GEMINI_API_KEY` and `PERPLEXITY_API_KEY` env vars take precedence over config file values. Set `"enabled": false` under `githubClone`, `youtube`, or `video` to disable those features.

`searchProvider` controls `web_search` default: `"auto"` (Perplexity → Gemini API → Gemini Web), `"perplexity"`, or `"gemini"` (API → Web).

## Rate Limits

- **Perplexity API**: 10 requests/minute (enforced client-side)
- **Content Fetch**: 3 concurrent requests, 30s timeout per URL
- **Cache TTL**: 1 hour

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `perplexity.ts` | Perplexity API client, rate limiting |
| `gemini-search.ts` | Gemini search providers (Web + API with grounding), search routing |
| `extract.ts` | URL/file path routing, HTTP extraction, Gemini fallback orchestration |
| `gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `video-extract.ts` | Local video file detection, upload, Gemini Web/API analysis |
| `youtube-extract.ts` | YouTube URL detection, three-tier extraction orchestrator |
| `chrome-cookies.ts` | macOS Chrome cookie extraction (Keychain + SQLite) |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-api.ts` | Gemini REST API client (generateContent, file upload) |
| `utils.ts` | Shared formatting (`formatSeconds`) and error helpers for frame extraction |
| `github-extract.ts` | GitHub URL parser, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for oversized repos and commit SHAs |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for observability widget |
| `skills/librarian/` | Bundled skill for library research with permalinks |

## Limitations

- Content extraction works best on article-style pages; JS-heavy sites fall back to Gemini extraction when available
- Gemini extraction fallback requires either a Gemini API key or Chrome login to Google
- PDFs are extracted as text (no OCR for scanned documents)
- Max response size: 20MB for PDFs, 5MB for HTML
- Max inline content: 30,000 chars per URL (larger content stored for retrieval via get_search_content)
- GitHub cloning requires `gh` CLI for private repos (public repos fall back to `git clone`)
- GitHub branch names with slashes (e.g. `feature/foo`) may resolve the wrong file path; the clone still succeeds and the agent can navigate manually
- Non-code GitHub URLs (issues, PRs, wiki, etc.) fall through to normal Readability extraction
- YouTube extraction via Gemini Web requires macOS (Chrome cookie decryption is OS-specific); other platforms fall through to Gemini API or Perplexity
- YouTube private/age-restricted videos may fail on all paths
- Gemini can process videos up to ~1 hour at default resolution; longer videos may be truncated
- First-time Chrome cookie access may trigger a macOS Keychain permission dialog
- Requires Pi restart after config file changes
