# pi-web-access Architecture

## Overview

pi-web-access is a web search and content extraction package for the Pi coding agent. It provides a unified interface for searching the web, extracting content from URLs, understanding videos and images, and performing semantic search with Exa.ai-style reranking.

## Core Components

### 1. Search Integration (SearXNG + Firecrawl)

The search system uses SearXNG for search aggregation and Firecrawl for content extraction:

#### SearXNG (Port 8081)
- Privacy-respecting metasearch engine
- Aggregates results from Google, Bing, DuckDuckGo, Brave, Wikipedia
- Returns structured JSON with URLs, titles, snippets
- Used by Firecrawl internally for search

#### Firecrawl (Port 3002)
- Two distinct functions:
  1. **Search** (`/v1/search`) - Uses SearXNG internally to find URLs
  2. **Scrape** (`/v1/scrape`) - Extracts content from URLs using Playwright
- Configured via `~/.pi/web-search.json` with `FIRECRAWL_API_KEY`
- Primary provider for both search and content extraction

**Search Flow:**
```
Query → Firecrawl Search (uses SearXNG internally) → URLs → Firecrawl Scrape → Content
```

### 2. Content Extraction (HTTP → Jina → Firecrawl → Browser Stealth)

When a URL needs to be scraped for content, the extraction pipeline follows this order:

#### Extraction Pipeline
```
URL → HTTP Fetch → Jina Reader → Firecrawl Scrape → Browser Stealth
```

#### HTTP Fetch (`extractViaHttp`)
- Direct HTTP request to URL
- Parses HTML using Readability (Mozilla)
- Converts to markdown using Turndown
- Fastest option, works for static pages

#### Jina Reader (`extractWithJinaReader`)
- Fallback when HTTP fetch fails
- Uses Jina AI's reader API (`r.jina.ai/`)
- Extracts clean markdown from any URL

#### Firecrawl Scrape (`extractWithFirecrawl`)
- Renders pages using Playwright (Chromium)
- Extracts markdown content using Readability
- Handles dynamic content, cookies, and authentication
- Configured via `firecrawl-fetch.ts`

#### Browser Stealth (`extractViaBrowserStealth`)
- Final fallback for JS-rendered or protected content
- Uses user's real Chrome browser (shared sessions, real fingerprint)
- Bypasses anti-bot detection (Cloudflare, Datadome, PerimeterX)
- Useful for sites that block automated scrapers

#### Type-Specific Extraction
```
URL → Check Type (Video/YouTube/PDF/GitHub) → Extract Content → Filter → Continue Pipeline
```

### 3. Video/Image Understanding (Standalone Frame Extraction + Gemma 4)

Video and image understanding is handled separately from text content. This is a **standalone multimodal pipeline** that extracts frames and sends them to Gemma 4 E2B for analysis.

#### Video Understanding Flow
```
Video URL → FFmpeg Frame Extraction → Base64 Images → Gemma 4 E2B (Multimodal) → Structured Summary
```

#### YouTube Videos (`youtube-extract.ts`)
1. **Extract stream URL** using `yt-dlp`
2. **Extract frames** at calculated timestamps (max 60 frames for 60s video)
3. **Send to Gemma 4** via `queryLocalLlmMultimodal()` with:
   - Frame images (base64 encoded)
   - Text prompt asking for summary, transcript, visual descriptions
4. **Parse response** for structured output (title, summary, transcript, visual descriptions)

#### Local Video Files (`video-extract.ts`)
1. **Detect video file** by extension (.mp4, .mov, .webm, .avi)
2. **Get duration** using `ffprobe`
3. **Extract frames** at calculated timestamps
4. **Send to Gemma 4** via `queryLocalLlmMultimodal()`
5. **Parse response** for structured output

#### Image Understanding (`extract.ts`)
1. **Detect image URLs** (.jpg, .png, .gif, .webp)
2. **Download image** and convert to base64
3. **Send to Gemma 4** via `queryLocalLlmMultimodal()` with image + text prompt
4. **Parse response** for detailed description

#### Gemma 4 Multimodal API (`local-llm-api.ts`)
```typescript
queryLocalLlmMultimodal(contents: MultimodalContent[], options)
```
- **Contents array**: Images first, then text prompt
- **Format**: `[{type: "image", base64: "...", mimeType: "image/jpeg"}, {type: "text", text: "Describe this image"}]`
- **Gemma 4 E2B specs**: Supports up to 60 seconds at 1fps, image token budgets: 70/140/280/560/1120
- **Best practice**: Images must come before text in the content array

### 4. Exa.ai-Style Semantic Search Pipeline

The Exa pipeline refines search results using semantic embeddings and reranking.

#### Pipeline Flow
```
Query → Multi-Source Search → Content Extraction → BGE-M3 Embeddings → Vector DB → Semantic Reranking → Gemma 4 Summaries
```

#### Step 1: Search
- Firecrawl search (`/v1/search`) uses SearXNG internally
- Returns URLs, titles, snippets from Google, Bing, etc.
- Low-quality results (snippet < 200 chars) are filtered

#### Step 2: Content Extraction
- For each URL, extract content based on type:
  - **YouTube**: Frame extraction + Gemma 4 multimodal
  - **Local Video**: Frame extraction + Gemma 4 multimodal
  - **Images**: Base64 encoding + Gemma 4 multimodal
  - **Web Pages**: HTTP → Jina → Firecrawl → Browser Stealth extraction
- Results with content < 200 chars are filtered

#### Step 3: BGE-M3 Embeddings
- Each document is embedded using BGE-M3 ONNX model
- Embeddings are 1024-dimensional, L2-normalized
- Performance: ~21 embeddings/sec on CPU
- Uses sentencepiece tokenizer for proper tokenization

#### Step 4: Vector DB Storage
- Documents are stored in SQLite with embeddings
- Supports semantic search with cosine similarity
- Binary quantization for memory efficiency (32x savings)

#### Step 5: Semantic Reranking
- Query is embedded using BGE-M3
- Cosine similarity computed between query and document embeddings
- Results sorted by similarity score
- Exa.ai-style: embed query + documents, rank by cosine similarity

#### Step 6: Gemma 4 Summaries
- Top 10 results are summarized using Gemma 4 E2B
- Summary includes: title, key points, relevance to query
- Generated via `generateSummaryDraft()` with context

### 5. Gemma 4 E2B (Local LLM)

Gemma 4 E2B serves as the local LLM for all text generation tasks:

#### Configuration
- **Model**: `gemma-4-E2B-it-UD-Q4_K_XL.gguf` (3.0GB, Q4_K_XL quantization)
- **Server**: `http://localhost:8082/v1` (llama.cpp)
- **Parameters**: temperature=1.0, top_p=0.95, top_k=64
- **Flash Attention**: ON
- **Reasoning**: Auto (enabled when needed)

#### Performance
- **Text generation**: ~32 tokens/sec on CPU
- **Embeddings**: Not supported (uses BGE-M3 instead)
- **Multimodal**: Supports images and video (up to 60s at 1fps)

#### API Functions
```typescript
// Text generation
queryLocalLlm(prompt: string, options)

// Multimodal (images/video)
queryLocalLlmMultimodal(contents: MultimodalContent[], options)

// Embeddings (BGE-M3 ONNX)
generateEmbedding(text: string, options)

// Cosine similarity
cosineSimilarity(a: number[], b: number[])
```

## File Structure

```
pi-web-access/
├── local-llm-api.ts        # Gemma 4 API + BGE-M3 embeddings
├── exa-pipeline.ts         # Full Exa.ai pipeline
├── exa-vector-db.ts        # SQLite vector database
├── firecrawl-search.ts     # Firecrawl search + semantic reranking
├── firecrawl-fetch.ts      # Firecrawl content extraction
├── searxng-search.ts       # SearXNG search integration
├── youtube-extract.ts      # YouTube video understanding
├── video-extract.ts        # Local video file understanding
├── extract.ts              # Web page content extraction
├── summary-review.ts       # Gemma 4 summary generation
├── index.ts                # Main entry + tool registration
└── ARCHITECTURE.md         # This file
```

## Infrastructure

### Ports
- **3002**: Firecrawl (search via SearXNG + content extraction via Playwright)
- **8081**: SearXNG (search aggregation - used internally by Firecrawl)
- **8082**: Gemma 4 E2B (local LLM + multimodal)
- **User's Chrome**: Browser stealth (shares real browser sessions, bypasses anti-bot)

### Models
- **Gemma 4 E2B**: `~/.local/llm/models/gemma-4-E2B-it-UD-Q4_K_XL.gguf` (3.0GB)
- **BGE-M3 ONNX**: `~/.local/llm/models/onnx/` (3.0GB)

### Dependencies
- **better-sqlite3**: Vector database
- **onnxruntime**: BGE-M3 embeddings
- **sentencepiece**: BGE-M3 tokenizer
- **ffmpeg**: Video frame extraction
- **yt-dlp**: YouTube stream extraction

## Usage

### Exa Pipeline
```typescript
import { exaPipeline } from "./exa-pipeline.js";

const results = await exaPipeline("cancer research advances 2026", {
  numResults: 20,
  enableVectorSearch: true,
  enableReranking: true,
  enableSummaries: true,
  enableIndexing: true,
});
```

### Direct API Calls
```typescript
import { queryLocalLlm, queryLocalLlmMultimodal, generateEmbedding } from "./local-llm-api.js";

// Text generation
const summary = await queryLocalLlm("Summarize this: " + content);

// Multimodal (images/video)
const description = await queryLocalLlmMultimodal([
  { type: "image", base64: "...", mimeType: "image/jpeg" },
  { type: "text", text: "Describe this image in detail" }
]);

// Embeddings
const embedding = await generateEmbedding("Represent this document: " + content);
```
