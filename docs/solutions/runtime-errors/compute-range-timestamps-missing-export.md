---
title: computeRangeTimestamps not exported from extract.ts causes video extraction crash
date: 2026-05-23
category: runtime-errors
module: pi-web-access
problem_type: runtime_error
component: tooling
symptoms:
  - "fetch_content({ url: \"/path/to/video.mp4\", prompt: \"...\" }) returns error: computeRangeTimestamps is not defined"
  - "Video extraction crashes immediately on import, before any video processing occurs"
root_cause: config_error
resolution_type: code_fix
severity: high
tags: [compute-range-timestamps, export, video-extraction, extract.ts, runtime-error]
---

# computeRangeTimestamps not exported from extract.ts causes video extraction crash

## Problem

The `video-extract.ts` module imports `computeRangeTimestamps` from `extract.js`, but the function was defined without the `export` keyword. This causes a runtime import error that crashes video extraction before any processing begins.

## Symptoms

- `fetch_content({ url: "/path/to/video.mp4", prompt: "..." })` fails with: `computeRangeTimestamps is not defined`
- Video extraction fails for all local video files
- The error occurs at module load time, not at runtime during video processing

## What Didn't Work

- **Adding the import to video-extract.ts:** The import statement `import { computeRangeTimestamps } from "./extract.js"` was already present. The issue was not a missing import — it was a missing export on the definition side.
- **Checking for typos:** The function name was spelled correctly in both the import and the definition. The issue was purely the missing `export` keyword.

## Solution

Added the `export` keyword to the `computeRangeTimestamps` function declaration in `extract.ts`:

**Before:**
```typescript
function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
```

**After:**
```typescript
export function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
```

The fix is a single-character change (`export ` prefix) at `extract.ts:156`.

## Why This Works

The `computeRangeTimestamps` function is used by both `extract.ts` (internally, for timestamp range calculations) and `video-extract.ts` (imported for local video frame extraction). Without the `export` keyword, the function is module-scoped and invisible to other modules. Adding `export` makes it available for named imports.

The function is called in `video-extract.ts:244`:
```typescript
const timestamps = computeRangeTimestamps(0, Math.floor(duration), maxFrames);
```

This call requires the function to be exported from `extract.ts`.

## Prevention

- **Export audit:** When adding a new function that will be imported by other modules, add the `export` keyword at definition time. Don't add it later when the import is discovered.
- **Import verification:** When adding an import statement, verify the export exists in the source module. A quick `grep -n "^export" source.ts` confirms availability.
- **Build-time checks:** If using TypeScript, ensure `noUnusedLocals` and `verbatimModuleSyntax` are enabled to catch mismatched imports/exports at compile time.

## Related

- `video-extract.ts` — Local video frame extraction using ffmpeg
- `extract.ts` — Content extraction utilities including `computeRangeTimestamps`
- `youtube-extract.ts` — YouTube video extraction (also uses frame extraction)
- `docs/solutions/tooling-decisions/firecrawl-replacement-for-gemini-tavily.md` — Related pi-web-access refactoring
