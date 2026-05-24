---
title: YouTube Video Extraction via Qwen3.6 Multimodal — yt-dlp + ffmpeg + frame analysis
date: 2026-05-24
category: architecture-patterns
module: video-extraction
problem_type: architecture_pattern
component: video-processing
severity: high
applies_when:
  - "Extracting YouTube video content for summarization or analysis"
  - "Need frame-based video understanding without cloud API dependencies"
  - "Replacing Gemini API video analysis with local multimodal model"
tags: [youtube, qwen3.6, multimodal, yt-dlp, ffmpeg, frame-extraction, video-analysis]
---

# YouTube Video Extraction via Qwen3.6 Multimodal

## Context

The `fetch_content` tool in pi-web-access needed to extract and summarize YouTube video content. The original approach used the Gemini API for video analysis, which required an API key and sent video data to Google. The replacement uses a local pipeline:

```
YouTube URL → yt-dlp (stream URL + duration) → ffmpeg (frame extraction) → Qwen3.6 multimodal → Structured summary
```

This pipeline is fully self-hosted, requires no API keys, and processes video frames locally.

## Architecture

### Pipeline Stages

**Stage 1: Stream Discovery (yt-dlp)**
- `yt-dlp` extracts the direct video stream URL and duration from a YouTube video
- Returns `streamUrl` (direct .mp4/.webm URL) and `duration` (seconds)
- Handles all YouTube URL formats: `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`

**Stage 2: Frame Scheduling**
- Calculate frame timestamps based on video duration
- Max 60 frames (Qwen3.6 multimodal limit), minimum 1 frame
- Minimum 5-second interval between frames
- For short videos (< 5s), use a single frame at t=0
- For long videos, evenly space frames with `interval = max(5, floor(duration / (maxFrames - 1)))`

**Stage 3: Frame Extraction (ffmpeg)**
- Extract frames from the direct stream at calculated timestamps
- Use `-ss` (seek) + `-frames:v 1` for efficient single-frame extraction
- Each frame is base64-encoded for multimodal API input

**Stage 4: Multimodal Analysis (Qwen3.6)**
- Send frames + prompt to Qwen3.6 running on port 8082
- Prompt: "Extract the complete content of this YouTube video. Include timestamps, key topics, and any code or commands shown."
- Qwen3.6 returns structured markdown summary

### Fallback Chain

```typescript
// Primary: yt-dlp + ffmpeg + Qwen3.6 multimodal
const result = await tryLocalLlmMultimodal(canonicalUrl, prompt, model, signal);

// Fallback: text-only Qwen3.6 summary (if multimodal fails)
// Fallback: placeholder response with video metadata
```

## Implementation Details

### Frame Extraction Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `MAX_VIDEO_FRAMES` | 60 | Qwen3.6 multimodal limit |
| `MIN_FRAME_INTERVAL` | 5s | Minimum spacing between frames |
| `maxFrames` | `min(60, max(3, floor(duration)))` | At least 3 frames for any video |
| `interval` | `max(5, floor(duration / (maxFrames - 1)))` | Even spacing, minimum 5s |

### Frame Extraction Code

```typescript
const timestamps: number[] = [];
if (maxFrames <= 1) {
    timestamps.push(0);
} else {
    const interval = Math.max(MIN_FRAME_INTERVAL, Math.floor(duration / (maxFrames - 1)));
    for (let t = 0; t <= duration && timestamps.length < maxFrames; t += interval) {
        timestamps.push(t);
    }
}

const framePromises = timestamps.map(async (t) => {
    const frame = await extractFrameFromStream(streamInfo.streamUrl, t);
    if ("error" in frame) return null;
    return { ...frame, timestamp: `${t}s` };
});
const frameResults = (await Promise.all(framePromises))
    .filter((f): f is NonNullable<typeof f> => f !== null);
```

### Multimodal Input Format

```typescript
const contents: Array<{ type: string; base64?: string; mimeType?: string; text?: string }> =
    frameResults.map((f) => ({
        type: "image",
        base64: f.data,
        mimeType: f.mimeType,
    }));
contents.push({ type: "text", text: prompt || YOUTUBE_PROMPT });

const text = await queryLocalLlmMultimodal(contents, {
    model,
    signal,
    timeoutMs: 120000,
    maxTokens: 4096,
});
```

## Why This Works

1. **yt-dlp is the gold standard** for extracting YouTube stream URLs — it handles all formats, regions, and URL variations
2. **ffmpeg is efficient** for frame extraction — `-ss` seeks directly to the timestamp, no need to decode the entire video
3. **Qwen3.6 multimodal** can analyze multiple frames and produce structured summaries with timestamps
4. **Fully self-hosted** — no API keys, no data leaves the machine
5. **Graceful degradation** — if multimodal fails, falls back to text-only Qwen3.6 summary

## Edge Cases

### Live Streams
- Live streams have no fixed duration — `yt-dlp` returns `duration: null` or a large value
- Handle by capping frames at 60 with 5s intervals (max 300s of content)
- For streams > 300s, use a single frame at t=0

### Videos with No Extractable Frames
- If ffmpeg fails to extract any frames (e.g., encrypted stream), return null
- The caller should fall back to text-only summary or placeholder

### Very Short Videos (< 5s)
- Single frame at t=0 is sufficient
- No need for interval calculation

### Videos with No Audio
- Frame extraction works identically — audio is irrelevant for visual analysis

## Related

- `youtube-extract.ts` — YouTube extraction pipeline
- `video-extract.ts` — Local video frame extraction
- `extract.ts` — Content extraction utilities including `computeRangeTimestamps`
- `local-llm-api.ts` — Qwen3.6 multimodal API client
- `docs/solutions/runtime-errors/compute-range-timestamps-missing-export.md` — Related runtime fix
- `docs/solutions/architecture-patterns/code-search-race-condition.md` — Related race condition pattern
