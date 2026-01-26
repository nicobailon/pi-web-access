# Pi Web Access - Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
