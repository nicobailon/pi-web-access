# Pi Web Access - Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
