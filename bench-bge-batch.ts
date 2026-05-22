import * as ort from 'onnxruntime-node';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';

async function benchmark() {
  console.log('Loading BGE-M3 ONNX...');
  const session = await ort.InferenceSession.create('/home/john/.local/llm/models/onnx/model.onnx', {
    providers: ['CPUExecutionProvider']
  });
  console.log('Model loaded.');
  
  const tokenizer = new SentencePieceProcessor();
  await tokenizer.load('/home/john/.local/llm/models/onnx/sentencepiece.bpe.model');
  
  const texts = Array(20).fill('The stock market experienced significant volatility today as investors reacted to mixed economic data.');
  
  // Test 1: Single embeddings (current implementation)
  console.log('\n=== Single embeddings (current) ===');
  const start1 = Date.now();
  for (const text of texts) {
    const ids = tokenizer.encodeIds(text);
    const inputIds = BigInt64Array.from(ids.map(BigInt));
    const attnMask = BigInt64Array.from(ids.map(() => BigInt(1)));
    await session.run({
      input_ids: new ort.Tensor('int64', inputIds, [1, ids.length]),
      attention_mask: new ort.Tensor('int64', attnMask, [1, ids.length]),
    });
  }
  const elapsed1 = Date.now() - start1;
  console.log(`20 embeddings: ${elapsed1}ms`);
  console.log(`Throughput: ${(20 / (elapsed1 / 1000)).toFixed(2)} embeddings/sec`);
  console.log(`Latency per embedding: ${(elapsed1 / 20).toFixed(0)}ms`);
  
  // Test 2: Batched embeddings
  console.log('\n=== Batched embeddings ===');
  
  // Tokenize all texts
  const allIds = texts.map(t => tokenizer.encodeIds(t));
  const maxLen = Math.max(...allIds.map(ids => ids.length));
  
  // Pad all sequences to max length
  const paddedIds = allIds.map(ids => {
    const padded = [...ids, ...Array(maxLen - ids.length).fill(0)];
    return BigInt64Array.from(padded.map(BigInt));
  });
  const paddedMask = allIds.map(ids => {
    const mask = [...ids.map(() => 1n), ...Array(maxLen - ids.length).fill(0n)];
    return BigInt64Array.from(mask);
  });
  
  // Create batched tensors
  const batchInputIds = new BigInt64Array(texts.length * maxLen);
  const batchAttnMask = new BigInt64Array(texts.length * maxLen);
  
  for (let i = 0; i < texts.length; i++) {
    for (let j = 0; j < maxLen; j++) {
      batchInputIds[i * maxLen + j] = paddedIds[i][j];
      batchAttnMask[i * maxLen + j] = paddedMask[i][j];
    }
  }
  
  // Warmup
  await session.run({
    input_ids: new ort.Tensor('int64', batchInputIds, [texts.length, maxLen]),
    attention_mask: new ort.Tensor('int64', batchAttnMask, [texts.length, maxLen]),
  });
  
  // Benchmark
  const start2 = Date.now();
  for (let run = 0; run < 3; run++) {
    await session.run({
      input_ids: new ort.Tensor('int64', batchInputIds, [texts.length, maxLen]),
      attention_mask: new ort.Tensor('int64', batchAttnMask, [texts.length, maxLen]),
    });
  }
  const elapsed2 = Date.now() - start2;
  console.log(`3 batches of 20: ${elapsed2}ms`);
  console.log(`Throughput: ${(60 / (elapsed2 / 1000)).toFixed(2)} embeddings/sec`);
  console.log(`Latency per batch: ${(elapsed2 / 3).toFixed(0)}ms`);
  console.log(`Latency per embedding: ${(elapsed2 / 60 * 1000).toFixed(0)}ms`);
}

benchmark().catch(console.error);
