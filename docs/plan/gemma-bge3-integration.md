# Gemma 4 + BGE-M3 Integration Plan

## Overview

This plan outlines the integration of Gemma 4 (local LLM) and BGE-M3 (ONNX embedding model) into the pi-web-access pipeline for semantic search, re-ranking, content summarization, and video analysis.

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        pi-web-access                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Search Layer:                                                  │
│  ├── Firecrawl (self-hosted, localhost:3002)                   │
│  ├── SearXNG (Docker, localhost:8085)                          │
│  └── LightPanda (Docker, localhost:3003) — rendering           │
│                                                                 │
│  Semantic Layer:                                                │
│  ├── BGE-M3 ONNX (~2.2GB) — embeddings                         │
│  ├── Gemma 4 Q4_K_XL (localhost:8082) — reranking              │
│  └── Exa Vector DB (SQLite + binary quantized embeddings)      │
│                                                                 │
│  Extraction Layer:                                              │
│  ├── Content extraction (Readability + Turndown)               │
│  ├── Video extraction (ffmpeg + frame sampling)                │
│  └── YouTube extraction (yt-dlp)                               │
│                                                                 │
│  LLM Layer:                                                     │
│  ├── Qwen3.6-35B (localhost:8080) — Claude Code default        │
│  ├── Gemma 4-E2B (localhost:8082) — firecrawl/summarization    │
│  └── BGE-M3 ONNX (CPU) — embeddings                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## GPU Constraints

| Model | VRAM | Status |
|-------|------|--------|
| Qwen3.6-35B (Q4_K_XL) | ~13.3 GB | Running on GPU (-ngl 25) |
| Gemma 4-E2B (Q4_K_XL) | ~2.4 GB | Running on GPU (267 TPS) |
| BGE-M3 ONNX | ~4 GB (FP16) | **CPU only** — needs GPU |
| **Total VRAM** | **16 GB** | **Overcommitted** |

## Goals

1. **Semantic Search**: Integrate BGE-M3 embeddings for vector search alongside existing Exa pipeline
2. **Re-ranking**: Use Gemma 4 for semantic re-ranking of search results (already partially implemented)
3. **Content Summarization**: Use Gemma 4 for summarizing extracted content
4. **Video Analysis**: Standalone Gemma 4 capability for frame-by-frame video analysis
5. **GPU Optimization**: Maximize throughput for all models within VRAM constraints

## Phase 1: BGE-M3 ONNX Integration

### 1.1 Embedding Service

**File**: `embedding-service.ts`

```typescript
/**
 * BGE-M3 ONNX Embedding Service
 * Uses onnxruntime-node for CPU inference
 * Supports multiple embedding dimensions (1024 for BGE-M3)
 */

import * as ort from 'onnxruntime-node';
import { readFileSync } from 'fs';
import { join } from 'path';

const MODEL_PATH = '/home/john/.local/llm/models/onnx/model.onnx';
const TOKENIZER_PATH = '/home/john/.local/llm/models/onnx/tokenizer.json';
const VOCAB_PATH = '/home/john/.local/llm/models/onnx/sentencepiece.bpe.model';

export class BGEEmbeddingService {
  private session: ort.InferenceSession | null = null;
  private tokenizer: any;
  
  async initialize(): Promise<void> {
    // Load ONNX model
    this.session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu']
    });
    
    // Load tokenizer (sentencepiece)
    // Implement BPE tokenizer for BGE-M3
  }
  
  async embed(texts: string[]): Promise<number[][]> {
    // Tokenize inputs
    // Run ONNX inference
    // Mean pool last hidden state
    // L2 normalize embeddings
  }
  
  async cosineSimilarity(a: number[], b: number[]): Promise<number> {
    // Standard cosine similarity
  }
}
```

### 1.2 Integration with Exa Pipeline

**File**: `exa-pipeline.ts` (modify)

```typescript
// Add BGE-M3 embedding step
const embeddingService = new BGEEmbeddingService();
await embeddingService.initialize();

// Step 1.5: Generate embeddings for search results
const embeddings = await embeddingService.embed(
  allResults.map(r => `${r.title} ${r.snippet}`)
);

// Step 1.6: Vector search using cosine similarity
const vectorResults = await searchSimilar(queryEmbedding, embeddings);
```

### 1.3 Performance Target

| Metric | Target |
|--------|--------|
| Embedding latency (10 texts) | < 500ms |
| Embedding latency (100 texts) | < 3s |
| Memory usage | < 2 GB |

## Phase 2: Gemma 4 Re-ranking Optimization

### 2.1 Current Status

- Reranker implemented in `reranker.ts`
- Uses Gemma 4 via local LLM API
- Batch processing with configurable batch size
- Score range: 1-10 relevance

### 2.2 Optimizations

#### 2.2.1 Prompt Engineering

```typescript
// Current: Open-ended relevance scoring
// Optimized: Structured JSON output for faster parsing

const prompt = `Given query: "${query}"
Evaluate relevance of each result (1-10):
{
  "url": "...",
  "title": "...",
  "score": <1-10>,
  "reason": "<brief>"
}

Results to evaluate:
${results.map(r => `URL: ${r.url}\nTitle: ${r.title}\nSnippet: ${r.snippet}`).join('\n\n')}

Output JSON for each result:`;
```

#### 2.2.2 Batch Size Tuning

| Batch Size | TPS | Memory | Recommendation |
|------------|-----|--------|----------------|
| 5 | ~250 | Low | Safe baseline |
| 10 | ~267 | Medium | **Optimal** |
| 20 | ~240 | High | Risk of OOM |

#### 2.2.3 Parallel Reranking

```typescript
// Parallel batch processing
const batchSize = 10;
const batches = chunk(results, batchSize);
const promises = batches.map(batch => rerankBatch(query, batch));
const allResults = (await Promise.all(promises)).flat();
```

### 2.3 Performance Target

| Metric | Target |
|--------|--------|
| Rerank 50 results | < 5s |
| Rerank 100 results | < 10s |
| Score consistency | > 0.9 correlation |

## Phase 3: Content Summarization

### 3.1 Summarization Pipeline

**File**: `summary-review.ts` (modify)

```typescript
export async function generateSummary(
  content: ExtractedContent,
  query: string,
  options: SummaryOptions = {}
): Promise<SummaryResult> {
  const {
    maxTokens = 500,
    temperature = 0.7,
    includeSources = true,
  } = options;
  
  // Step 1: Extract key sections
  const sections = extractKeySections(content);
  
  // Step 2: Generate summary with Gemma 4
  const summary = await queryLocalLlm({
    model: 'gemma-4-e2b',
    messages: [{
      role: 'user',
      content: generateSummaryPrompt(query, sections, includeSources)
    }],
    max_tokens: maxTokens,
    temperature,
  });
  
  // Step 3: Validate summary quality
  const validated = validateSummary(summary, query);
  
  return validated;
}
```

### 3.2 Prompt Template

```
You are a research assistant. Summarize the following content
in relation to the query: "${query}"

Requirements:
1. Extract key facts and figures
2. Preserve numerical data and statistics
3. Include source URLs for verification
4. Keep it concise (max 500 tokens)
5. Use bullet points for clarity

Content:
${content}

Summary:
```

### 3.3 Performance Target

| Metric | Target |
|--------|--------|
| Summary latency (1000 words) | < 3s |
| Summary latency (5000 words) | < 8s |
| Information retention | > 90% |

## Phase 4: Video Analysis

### 4.1 Architecture

```
Video URL
    │
    ▼
┌──────────────┐
│  yt-dlp      │  Download video
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  ffmpeg      │  Extract frames (1 per second)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Gemma 4     │  Analyze each frame (vision)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Synthesize  │  Combine frame analyses
└──────────────┘
```

### 4.2 Implementation

**File**: `video-analysis.ts`

```typescript
export interface VideoAnalysisResult {
  summary: string;
  keyFrames: Array<{
    timestamp: number;
    description: string;
    confidence: number;
  }>;
  topics: string[];
  sentiment: 'positive' | 'negative' | 'neutral';
}

export async function analyzeVideo(
  videoUrl: string,
  options: VideoAnalysisOptions = {}
): Promise<VideoAnalysisResult> {
  // Step 1: Download video
  const videoPath = await downloadVideo(videoUrl);
  
  // Step 2: Extract frames
  const frames = await extractFrames(videoPath, {
    fps: options.fps ?? 1,
    resolution: options.resolution ?? '640x360',
  });
  
  // Step 3: Analyze frames with Gemma 4 Vision
  const frameAnalyses = await Promise.all(
    frames.map(frame => analyzeFrame(frame, options.prompt))
  );
  
  // Step 4: Synthesize results
  return synthesizeVideoAnalysis(frameAnalyses);
}
```

### 4.3 Gemma 4 Vision Support

**Note**: Gemma 4 E2B may not have native vision support. Alternative approaches:

1. **Use Qwen3.6-VL** (if available) — has native vision support
2. **Use external vision API** (OpenAI GPT-4V, Anthropic Claude)
3. **Extract key frames only** — analyze 10-20 key frames instead of all
4. **Use clip-based frame clustering** — group similar frames, analyze representatives

### 4.4 Performance Target

| Metric | Target |
|--------|--------|
| Frame extraction (1080p, 10min) | < 30s |
| Frame analysis (20 frames) | < 60s |
| Total processing time | < 2min |

## Phase 5: GPU Optimization

### 5.1 VRAM Allocation Strategy

| Model | VRAM | Layers on GPU | TPS |
|-------|------|---------------|-----|
| Qwen3.6-35B | 13.3 GB | -ngl 25 | ~50 TPS |
| Gemma 4-E2B | 2.4 GB | All | ~267 TPS |
| BGE-M3 ONNX | 4 GB (FP16) | **None** (CPU) | ~10 texts/s |
| **Total** | **19.7 GB** | **16 GB available** | |

### 5.2 Optimization Options

#### Option A: Keep Current (CPU for BGE-M3)
- **Pros**: Stable, no VRAM conflicts
- **Cons**: Slow embeddings (~10 texts/s)

#### Option B: Offload BGE-M3 to GPU
- **Requires**: Stop Qwen3.6 or reduce -ngl to 15
- **Pros**: Faster embeddings (~100 texts/s on GPU)
- **Cons**: Qwen3.6 slower, Gemma may OOM

#### Option C: Use Smaller Embedding Model
- **Model**: BGE-small (335 dims, 134 MB)
- **Pros**: Fits on GPU easily
- **Cons**: Lower quality embeddings

#### Option D: Dynamic Loading
- **Strategy**: Load BGE-M3 only when needed, unload after use
- **Pros**: Maximizes VRAM for active models
- **Cons**: Loading/unloading overhead (~5s)

### 5.3 Recommended Approach

**Start with Option A (CPU)** — validate the pipeline works end-to-end. Then iterate to Option D (dynamic loading) for performance.

## Implementation Priority

1. **Priority 1**: BGE-M3 embedding service (Phase 1)
2. **Priority 2**: Reranker optimization (Phase 2)
3. **Priority 3**: Summarization pipeline (Phase 3)
4. **Priority 4**: Video analysis MVP (Phase 4)
5. **Priority 5**: GPU optimization (Phase 5)

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| onnxruntime-node | ^1.17.0 | BGE-M3 inference |
| @agnai/sentencepiece-js | ^1.0.0 | Tokenizer for BGE-M3 |
| ffmpeg-static | ^5.2.0 | Frame extraction |
| yt-dlp | ^2024.01.01 | Video download |

## Testing Strategy

1. **Unit Tests**: Embedding service, reranker, summarizer
2. **Integration Tests**: Full pipeline with sample queries
3. **Performance Tests**: TPS measurements, memory usage
4. **Quality Tests**: LLM-as-judge evaluation of summaries

## Success Metrics

| Metric | Baseline | Target |
|--------|----------|--------|
| Search latency | 5s | < 3s |
| Rerank 50 results | 10s | < 5s |
| Embedding 10 texts | 2s | < 0.5s |
| Summary 1000 words | 5s | < 3s |
| Video analysis 10min | N/A | < 2min |
