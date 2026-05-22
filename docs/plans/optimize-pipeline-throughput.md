# Optimize Pipeline Throughput - Qwen3.6 + BGE-M3 + BGE-large

## Goals

1. **Qwen3.6** (top priority): Maximize TPS for summarization and video analysis
2. **BGE-M3 embeddings**: Optimized for batch processing (200+ embeddings/sec)
3. **BGE-large reranker**: Optimized for fast reranking (100+ pairs/sec)
4. **Remove dead code**: Clean up Gemma 4 references and unused files
5. **Full pipeline**: Firecrawl + SearXNG → BGE-M3 → Vector DB → BGE-large → LightPanda → Qwen3.6

## Current State

| Model | TPS/Throughput | Settings |
|-------|----------------|----------|
| Qwen3.6-35B | ~55 TPS | -ngl 35, 14.4 GB VRAM |
| BGE-M3 ONNX | 200+ embeddings/sec | Batched (100 texts) |
| BGE-large ONNX | Downloaded | Not integrated |

## Implementation Plan

### Phase 1: Qwen3.6 Optimization (Top Priority)

**File**: `start-llm.sh`
- Current: `-ngl 35`
- Target: Find optimal -ngl for max TPS with 1.4GB VRAM free
- Test -ngl values: 30, 35, 40, 45
- Select -ngl that gives ~60 TPS

**File**: `summary-review.ts`
- Update preferred models to use Qwen3.6
- Remove Gemma 4 references

### Phase 2: BGE-M3 Embeddings Optimization

**File**: `local-llm-api.ts`
- Implement batched embedding generation
- Target: 200+ embeddings/sec with batch size 100
- API: `generateBatchedEmbeddings(texts[], batchSize=100)`

### Phase 3: BGE-large Reranker Integration

**File**: `reranker-bge.ts` (new)
- Implement BGE-large reranker using ONNX
- Target: 100+ pairs/sec with batch size 50
- API: `rerankWithBge(query, results, { batchSize: 50 })`

**File**: `exa-pipeline.ts`
- Update to use BGE reranker instead of Gemma 4
- Update imports and function calls

### Phase 4: Dead Code Removal

**Files to remove**:
- `bench-bge-batch.ts` (benchmark file)
- `bench-bge-v2.ts` (benchmark file)
- `bench-reranker.ts` (benchmark file)

**Files to update**:
- `summary-review.ts` - Remove Gemma 4 references
- `local-llm-api.ts` - Remove Gemma 4 references
- `exa-pipeline.ts` - Remove Gemma 4 references

### Phase 5: Video Understanding

**File**: `video-extract.ts`
- Update to use Qwen3.6 for frame analysis
- Use yt-dlp for video download
- Extract frames and analyze with Qwen3.6

### Phase 6: GitHub/Code Search

**File**: `code-search.ts`
- Implement semantic analysis + fetch
- Use BGE-M3 embeddings for code search
- Use Qwen3.6 for code summarization

## Performance Targets

| Metric | Target | Current |
|--------|--------|---------|
| Qwen3.6 TPS | 60 | 55 |
| BGE-M3 embeddings/sec | 200+ | 200+ ✓ |
| BGE-large rerank pairs/sec | 100+ | Not integrated |

## Files to Modify

1. `start-llm.sh` - Qwen3.6 settings
2. `local-llm-api.ts` - BGE-M3 batched embeddings
3. `reranker-bge.ts` - New BGE reranker
4. `exa-pipeline.ts` - Update to use BGE reranker
5. `summary-review.ts` - Update to use Qwen3.6
6. `video-extract.ts` - Update to use Qwen3.6
7. `code-search.ts` - Implement semantic search

## Files to Remove

1. `bench-bge-batch.ts`
2. `bench-bge-v2.ts`
3. `bench-reranker.ts`
