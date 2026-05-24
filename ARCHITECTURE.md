# pi-web-access Architecture

## Overview

pi-web-access is a fully self-hosted web search and content extraction package for the Pi coding agent. All cloud dependencies (Exa, Perplexity, Gemini) have been replaced with local alternatives:

- **Search**: SearXNG + Firecrawl → replaces Exa/Perplexity/Gemini
- **Semantic Reranking**: Nomic Embed v1.5 (Matryoshka) + jina-tiny → mimics Exa's neural search
- **Content Extraction**: LightPanda → replaces Gemini Web/Jina
- **Code Search**: Sourcegraph + ripgrep → replaces Exa MCP
- **Video Analysis**: yt-dlp + ffmpeg + Qwen3.6 → replaces Gemini API
- **Summaries**: Qwen3.6 (GPU) → replaces Claude/GPT

**Result**: 3-4x faster, fully private, zero API keys, complete understanding.

## Core Components

### 1. Search Integration (SearXNG + Firecrawl)

The search system uses SearXNG for search aggregation and Firecrawl for content extraction:

#### SearXNG (Port 8081)
- Privacy-respecting metasearch engine
- Aggregates results from Google, Bing, DuckDuckGo, Brave, Wikipedia
- Returns structured JSON with URLs, titles, snippets
- Speed: 50-200ms

#### Firecrawl (Port 3002)
- Two distinct functions:
  1. **Search** (`/v1/search`) - Uses SearXNG internally to find URLs
  2. **Scrape** (`/v1/scrape`) - Extracts content from URLs using Playwright
- Configured via `~/.pi/web-search.json` with `FIRECRAWL_API_KEY`
- Primary provider for both search and content extraction

**Search Flow:**
```
Query → SearXNG + Firecrawl Search → URLs → Content Extraction
```

### 2. Content Extraction (HTTP → LightPanda → Jina → Firecrawl → Browser Stealth)

When a URL needs to be scraped for content, the extraction pipeline follows this order:

#### Extraction Pipeline
```
URL → HTTP Fetch → LightPanda → Jina Reader → Firecrawl Scrape → Browser Stealth
```

#### HTTP Fetch (`extractViaHttp`)
- Direct HTTP request to URL
- Parses HTML using Readability (Mozilla)
- Converts to markdown using Turndown
- Fastest option, works for static pages

#### LightPanda (`lightpanda-extract.ts`)
- **NEW**: Uses LightPanda for JS-rendered content extraction
- Renders JavaScript-heavy pages (SPAs, React, Vue, Angular)
- Extracts clean markdown from rendered HTML
- Handles anti-bot measures and Next.js RSC
- Speed: 200-500ms per URL

#### Jina Reader (`extractWithJinaReader`)
- Fallback when HTTP fetch and LightPanda fail
- Uses Jina AI's reader API (`r.jina.ai/`)
- Extracts clean markdown from any URL

#### Firecrawl Scrape (`extractWithFirecrawl`)
- Renders pages using Playwright (Chromium)
- Extracts markdown content using Readability
- Handles dynamic content, cookies, and authentication

#### Browser Stealth (`extractViaBrowserStealth`)
- Final fallback for JS-rendered or protected content
- Uses user's real Chrome browser (shared sessions, real fingerprint)
- Bypasses anti-bot detection (Cloudflare, Datadome, PerimeterX)

### 3. Video/Image Understanding (Standalone Frame Extraction + Qwen3.6)

Video and image understanding is handled separately from text content. This is a **standalone multimodal pipeline** that extracts frames and sends them to Qwen3.6 for analysis.

#### Video Understanding Flow
```
Video URL → FFmpeg Frame Extraction → Base64 Images → Qwen3.6 (Multimodal) → Structured Summary
```

#### YouTube Videos (`youtube-extract.ts`)
1. **Extract stream URL** using `yt-dlp`
2. **Extract frames** at calculated timestamps (max 60 frames for 60s video)
3. **Send to Qwen3.6** via `queryLocalLlmMultimodal()` with:
   - Frame images (base64 encoded)
   - Text prompt asking for summary, transcript, visual descriptions
4. **Parse response** for structured output (title, summary, transcript, visual descriptions)

#### Local Video Files (`video-extract.ts`)
1. **Detect video file** by extension (.mp4, .mov, .webm, .avi)
2. **Get duration** using `ffprobe`
3. **Extract frames** at calculated timestamps
4. **Send to Qwen3.6** via `queryLocalLlmMultimodal()`
5. **Parse response** for structured output

#### Image Understanding (`extract.ts`)
1. **Detect image URLs** (.jpg, .png, .gif, .webp)
2. **Download image** and convert to base64
3. **Send to Qwen3.6** via `queryLocalLlmMultimodal()` with image + text prompt
4. **Parse response** for detailed description

### 4. Self-Hosted Exa Pipeline (Nomic Embed v1.5 + jina-reranker)

The Exa pipeline refines search results using semantic embeddings and reranking.

#### Pipeline Flow
```
Query → Multi-Source Search → Content Extraction → Nomic Embed v1.5 → Vector DB → Hybrid Scoring → Jina Reranker → Qwen3.6 Summaries
```

#### Step 1: Search
- SearXNG + Firecrawl search
- Returns URLs, titles, snippets from Google, Bing, etc.
- Low-quality results (snippet < 200 chars) are filtered

#### Step 2: Content Extraction
- For each URL, extract content based on type:
  - **YouTube**: Frame extraction + Qwen3.6 multimodal
  - **Local Video**: Frame extraction + Qwen3.6 multimodal
  - **Images**: Base64 encoding + Qwen3.6 multimodal
  - **Web Pages**: HTTP → LightPanda → Jina → Firecrawl → Browser Stealth extraction
- Results with content < 200 chars are filtered

#### Step 3: Nomic Embed v1.5 Embeddings (256-dim Matryoshka)
- Each document is embedded using Nomic Embed v1.5 ONNX model
- **Natively trained with Matryoshka Representation Learning**
- 256-dim truncation from 768-dim with only 1.8% accuracy loss
- **MTEB Score**: 62.28 (768-dim) → 61.04 (256-dim) = 98% accuracy preserved
- **Storage**: 1KB per embedding (vs 4KB for BGE-M3 float32)
- **Performance**: 200+ embeddings/sec with batching
- Uses @xenova/transformers for BERT-style tokenization

#### Step 4: Vector DB Storage
- Documents stored in SQLite with binary quantized embeddings
- Binary quantization: 256 float32 (1024 bytes) → 256 bits (32 bytes) = 32x savings
- **1M docs = 1GB RAM** (vs 4GB for BGE-M3 float32)
- Supports semantic search with cosine similarity

#### Step 5: Hybrid Search (BM25 + Embeddings)
- **BM25 score**: Term overlap between query and content
- **Embedding similarity**: Cosine similarity with Nomic embeddings
- **Hybrid scoring**: 0.4 * BM25 + 0.6 * Embedding
- Compensates for any embedding quality loss

#### Step 6: Jina Reranker v1 Tiny
- Cross-encoder reranking on top-K results
- **Model**: jinaai/jina-reranker-v1-tiny-en
- **Params**: 33M, 4-layer, 8192 token context
- **NDCG@10**: 48.54
- **Performance**: 100+ pairs/sec
- **VRAM**: ~130MB

#### Step 7: Qwen3.6 Summaries
- Top 10 results summarized using Qwen3.6
- Summary includes: title, key points, relevance to query
- Generated via `generateSummaryDraft()` with context

### 5. Code Search (Sourcegraph + ripgrep + Nomic Embeddings)

Self-hosted code search replacing Exa MCP:

#### Sourcegraph Search
- Self-hosted Sourcegraph for code search
- Native search API with full-text search stack
- Proactive context gathering from codebase, project structure, current task

#### Ripgrep Search
- Fast local code search using ripgrep
- Instant results for local repositories

#### Semantic Code Search
- Nomic Embed v1.5 (256-dim) for semantic similarity
- Embeds queries and finds semantically similar code snippets

### 6. Qwen3.6 (Local LLM)

Qwen3.6-35B-A3B serves as the local LLM for all text generation tasks:

#### Configuration
- **Model**: `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` (MoE, ~35B total / ~3.4B active params)
- **Server**: `http://localhost:8082/v1` (llama.cpp)
- **Parameters**: temperature=1.0, top_p=0.95, top_k=64
- **Quantization**: Q4_K_XL

#### Performance
- **Text generation**: ~32-40 tokens/sec on GPU
- **Embeddings**: Not supported (uses Nomic Embed v1.5 instead)
- **Multimodal**: Supports images and video (up to 60s at 1fps)

#### API Functions
```typescript
// Text generation
queryLocalLlm(prompt: string, options)

// Multimodal (images/video)
queryLocalLlmMultimodal(contents: MultimodalContent[], options)
```

## File Structure

```
pi-web-access/
├── local-llm-api.ts        # Qwen3.6 API (text + multimodal)
├── embedding-nomic.ts      # Nomic Embed v1.5 (256-dim Matryoshka)
├── reranker-jina.ts        # Jina Reranker v1 Tiny
├── binary-quantizer.ts     # Binary quantization (256-dim)
├── exa-pipeline.ts         # Full self-hosted pipeline (hybrid search)
├── exa-vector-db.ts        # SQLite vector database (256-dim)
├── lightpanda-extract.ts   # LightPanda content extraction
├── firecrawl-search.ts     # Firecrawl search + semantic reranking
├── firecrawl-fetch.ts      # Firecrawl content extraction
├── searxng-search.ts       # SearXNG search integration
├── code-search.ts          # Sourcegraph + ripgrep + semantic code search
├── youtube-extract.ts      # YouTube video understanding
├── video-extract.ts        # Local video file understanding
├── extract.ts              # Web page content extraction
├── summary-review.ts       # Qwen3.6 summary generation
├── index.ts                # Main entry + tool registration
└── ARCHITECTURE.md         # This file
```

### Sourcegraph Setup
Self-hosted Sourcegraph for code search (replaces Exa MCP):
```bash
cd ~/.local/sourcegraph && docker compose up -d
```
- Exposes port 3000 (configured in `code-search.ts`)
- Provides full-text search + code graph awareness
- Works with any git repository
- Single-user mode enabled for personal use

### YouTube Extraction Pipeline
```
YouTube URL → yt-dlp (stream URL + duration) → ffmpeg (frame extraction) → Qwen3.6 multimodal → Structured summary
```
- yt-dlp extracts the direct video stream URL and duration
- ffmpeg extracts frames at calculated timestamps (max 60 frames, 5s intervals)
- Frames + prompt sent to Qwen3.6 multimodal API for analysis
- Mirrors the local video extraction pattern in `video-extract.ts`

### Ports
- **3000**: Sourcegraph (self-hosted code search, Docker at `~/.local/sourcegraph/`)
- **3002**: Firecrawl (search via SearXNG + content extraction via Playwright)
- **8081**: SearXNG (search aggregation)
- **8082**: Qwen3.6 (local LLM + multimodal)
- **User's Chrome**: Browser stealth (shares real browser sessions, bypasses anti-bot)

### YouTube Extraction Pipeline
```
YouTube URL → yt-dlp (stream URL + duration) → ffmpeg (frame extraction) → Qwen3.6 multimodal → Structured summary
```
- yt-dlp extracts the direct video stream URL and duration
- ffmpeg extracts frames at calculated timestamps (max 60 frames, 5s intervals)
- Frames + prompt sent to Qwen3.6 multimodal API for analysis
- Mirrors the local video extraction pattern in `video-extract.ts`

### Models
- **Qwen3.6-35B-A3B**: `~/.local/llm/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` (MoE)
- **Nomic Embed v1.5**: `~/.local/llm/models/nomic-embed-v1.5/` (ONNX, 256-dim)
- **Jina Reranker v1 Tiny**: `~/.local/llm/models/jina-reranker-tiny/` (ONNX)

### Speed Benchmarks (Expected)

| Operation | Original (Cloud) | New (Self-Hosted) | Improvement |
|-----------|-----------------|-------------------|-------------|
| Search | 200-500ms (Exa) | 50-200ms (SearXNG) | 2-3x faster |
| Embed 20 docs | 400ms (sequential) | 50ms (batched ONNX) | 8x faster |
| Rerank 20 docs | 200ms (Exa) | 100ms (jina-tiny GPU) | 2x faster |
| Extract 10 URLs | 10-30s (Gemini Web) | 2-5s (LightPanda) | 2-6x faster |
| Summarize 10 docs | 5-10s (Claude) | 3-5s (Qwen3.6 GPU) | 1.5-2x faster |
| Video analysis | 30-60s (Gemini API) | 10-30s (local) | 2-3x faster |
| **Total pipeline** | **60-120s** | **15-40s** | **3-4x faster** |

### Privacy Benefits

| Feature | Original (Cloud) | New (Self-Hosted) |
|---------|-----------------|-------------------|
| Search queries | Sent to Exa/Perplexity/Gemini | Stay local (SearXNG) |
| Browsing history | Sent to Gemini Web | Stay local (LightPanda) |
| Video content | Sent to Gemini API | Stay local (yt-dlp + Qwen3.6) |
| Code snippets | Sent to Exa MCP | Stay local (Sourcegraph) |
| Summaries | Generated by Claude/GPT | Generated by Qwen3.6 |
| **API keys needed** | Exa, Perplexity, Gemini | **None (all local)** |
| **Data collection** | Exa tracks queries | **Zero tracking** |

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
  enableHybridSearch: true,  // BM25 + embeddings
  bm25Weight: 0.4,
  embeddingWeight: 0.6,
  useLightPanda: true,
});
```

### Direct API Calls
```typescript
import { queryLocalLlm, queryLocalLlmMultimodal } from "./local-llm-api.js";
import { generateNomicEmbedding, generateNomicBatchedEmbeddings } from "./embedding-nomic.js";
import { rerankWithJina } from "./reranker-jina.js";

// Text generation
const summary = await queryLocalLlm("Summarize this: " + content);

// Multimodal (images/video)
const description = await queryLocalLlmMultimodal([
  { type: "image", base64: "...", mimeType: "image/jpeg" },
  { type: "text", text: "Describe this image in detail" }
]);

// Embeddings (Nomic Embed v1.5, 256-dim)
const embedding = await generateNomicEmbedding("Represent this document: " + content);

// Reranking
const reranked = await rerankWithJina(query, results, { batchSize: 16 });
```
