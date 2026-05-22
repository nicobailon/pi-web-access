import * as ort from 'onnxruntime-node';
import { SentencePieceProcessor } from '@agnai/sentencepiece-js';

async function benchmark() {
  console.log('Loading BGE reranker large...');
  const session = await ort.InferenceSession.create('/home/john/.local/llm/models/bge-reranker-large/onnx/model.onnx', {
    providers: ['CPUExecutionProvider']
  });
  console.log('Model loaded.');
  
  const tokenizer = new SentencePieceProcessor();
  await tokenizer.load('/home/john/.local/llm/models/bge-reranker-large/sentencepiece.bpe.model');
  
  // BGE reranker: encode query + text as a single sequence
  const query = 'stock market volatility';
  const text = 'The stock market experienced significant volatility today.';
  const pair = `[CLS] ${query} [SEP] ${text} [SEP]`;
  
  // Warmup
  const ids = tokenizer.encodeIds(pair);
  const inputIds = BigInt64Array.from(ids.map(BigInt));
  const attnMask = BigInt64Array.from(ids.map(() => BigInt(1)));
  
  await session.run({
    input_ids: new ort.Tensor('int64', inputIds, [1, ids.length]),
    attention_mask: new ort.Tensor('int64', attnMask, [1, ids.length]),
  });
  
  // Benchmark
  const start = Date.now();
  for (let i = 0; i < 10; i++) {
    await session.run({
      input_ids: new ort.Tensor('int64', inputIds, [1, ids.length]),
      attention_mask: new ort.Tensor('int64', attnMask, [1, ids.length]),
    });
  }
  const elapsed = Date.now() - start;
  
  console.log(`10 rerank pairs: ${elapsed}ms`);
  console.log(`Throughput: ${(10 / (elapsed / 1000)).toFixed(2)} pairs/sec`);
  console.log(`Latency per pair: ${(elapsed / 10).toFixed(0)}ms`);
}

benchmark().catch(console.error);
