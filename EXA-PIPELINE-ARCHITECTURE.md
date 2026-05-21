# Exa.ai-Style Semantic Search Pipeline Architecture

## Overview

This document describes the architecture for building an Exa.ai-style semantic search pipeline that:
1. Takes search results and semantically analyzes them using BGE-M3 ONNX embeddings
2. Compresses embeddings to binary quantization using numpy in a vector DB
3. Uses Gemma-4-E2B (port 8082) to re-rank search results
4. Runs after search and before scraping

## Current State

### Existing Components
- **Search**: Firecrawl (SearXNG) on port 3002
- **Embeddings**: BGE-M3 ONNX at `~/.local/llm/models/onnx/` (1024-dim)
- **LLM**: Gemma-4-E2B at `http://localhost:8082/v1` (optimized: 39 TPS)
- **Vector DB**: SQLite with base64-encoded float32 embeddings (NOT binary quantized)

### What's Missing
1. Binary quantization of embeddings (numpy)
2. Gemma-4-E2B reranking (currently uses cosine similarity)
3. Proper integration point (after search, before scraping)

## Architecture

### Pipeline Flow

```
Query → Search (Firecrawl/SearXNG) → URLs + Snippets
    ↓
[NEW] Binary Quantization (numpy) → Compressed embeddings
    ↓
[NEW] Vector DB (SQLite + binary quantized)
    ↓
[NEW] Semantic Search (cosine similarity on binary embeddings)
    ↓
[NEW] Gemma-4-E2B Reranking (semantic relevance scoring)
    ↓
Scraping (content extraction)
    ↓
Summarization (Gemma-4-E2B)
```

### Component Details

#### 1. BGE-M3 Embeddings (Existing)
- **Model**: BAAI/bge-m3 (ONNX format)
- **Dimensions**: 1024
- **Tokenizer**: sentencepiece (bpe.model)
- **Performance**: ~12-21 embeddings/sec on CPU
- **Path**: `~/.local/llm/models/onnx/model.onnx`

#### 2. Binary Quantization (New)
- **Method**: Sign-based binary quantization
- **Compression**: 1024 float32 (4096 bytes) → 1024 bits (128 bytes) = 32x savings
- **Algorithm**:
  ```python
  binary = (embedding > 0).astype(np.uint8)  # 1024 bits
  # Store as 128 bytes (1024 / 8)
  ```
- **Decoding**:
  ```python
  embedding = (binary.astype(np.float32) * 2 - 1)  # ±1 values
  ```

#### 3. Vector DB (Enhanced)
- **Storage**: SQLite with binary quantized embeddings
- **Index**: Full-scan cosine similarity (no ANN needed for <10K docs)
- **Schema**:
  ```sql
  CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE,
      title TEXT,
      content TEXT,
      embedding_binary BLOB,  -- 128 bytes per embedding
      created_at INTEGER
  );
  ```

#### 4. Gemma-4-E2B Reranking (New)
- **Model**: gemma-4-E2B (port 8082)
- **Method**: Prompt-based relevance scoring
- **Prompt**:
  ```
  Rate the relevance of this document to the query on a scale of 1-10.
  
  Query: {query}
  Title: {title}
  Snippet: {snippet}
  
  Return only a JSON object: {"score": <1-10>, "reason": "<brief explanation>"}
  ```
- **Batching**: Process 10-20 documents per batch for efficiency

## Implementation Plan

### Phase 1: Binary Quantization (numpy)
- [ ] Create `binary-quantizer.ts` with numpy-like operations
- [ ] Implement sign-based binary quantization
- [ ] Implement binary cosine similarity (Hamming distance approximation)
- [ ] Benchmark: float32 vs binary quantization

### Phase 2: Vector DB Integration
- [ ] Update `exa-vector-db.ts` to use binary quantized embeddings
- [ ] Implement binary cosine similarity search
- [ ] Add indexing for faster lookups

### Phase 3: Gemma-4-E2B Reranking
- [ ] Create `reranker.ts` with Gemma-4-E2B integration
- [ ] Implement prompt-based relevance scoring
- [ ] Add batching for efficiency
- [ ] Benchmark: cosine similarity vs Gemma-4-E2B reranking

### Phase 4: Integration
- [ ] Update `exa-pipeline.ts` to use new components
- [ ] Add integration point (after search, before scraping)
- [ ] Add configuration options
- [ ] Test end-to-end pipeline

## Files to Create/Modify

### New Files
- `pi-web-access/binary-quantizer.ts` - Binary quantization utilities
- `pi-web-access/reranker.ts` - Gemma-4-E2B reranking
- `pi-web-access/exa-pipeline-v2.ts` - Updated pipeline with new components

### Modified Files
- `pi-web-access/exa-vector-db.ts` - Binary quantized embeddings
- `pi-web-access/exa-pipeline.ts` - Integration of new components

## Dependencies
- **numpy**: Binary quantization (via pyodide or native node-numpy)
- **better-sqlite3**: Vector DB (existing)
- **onnxruntime**: BGE-M3 embeddings (existing)
- **sentencepiece**: Tokenizer (existing)

## Performance Targets
- **Embedding generation**: <100ms per document
- **Binary quantization**: <1ms per embedding
- **Vector search**: <10ms for <1000 documents
- **Gemma-4-E2B reranking**: <500ms per 10 documents
- **Total pipeline**: <5 seconds for 20 documents

## Notes
- Binary quantization trades accuracy for memory efficiency (32x savings)
- Gemma-4-E2B reranking provides semantic relevance scoring beyond cosine similarity
- The pipeline should be configurable to use either cosine similarity or Gemma-4-E2B reranking
