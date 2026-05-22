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
  
  const texts = Array(50).fill('The stock market experienced significant volatility today as investors reacted to mixed economic data.');
  
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
  
  // Test different batch sizes
  for (const batchSize of [10, 20, 50, 100]) {
    const batchTexts = texts.slice(0, batchSize);
    const batchIds = batchTexts.map(t => tokenizer.encodeIds(t));
    const batchMaxLen = Math.max(...batchIds.map(ids => ids.length));
    
    const batchPaddedIds = batchIds.map(ids => {
      const padded = [...ids, ...Array(batchMaxLen - ids.length).fill(0)];
      return BigInt64Array.from(padded.map(BigInt));
    });
    const batchPaddedMask = batchIds.map(ids => {
      const mask = [...ids.map(() => 1n), ...Array(batchMaxLen - ids.length).fill(0n)];
      return BigInt64Array.from(mask);
    });
    
    const batchInputIds = new BigInt64Array(batchTexts.length * batchMaxLen);
    const batchAttnMask = new BigInt64Array(batchTexts.length * batchMaxLen);
    
    for (let i = 0; i < batchTexts.length; i++) {
      for (let j = 0; j < batchMaxLen; j++) {
        batchInputIds[i * batchMaxLen + j] = batchPaddedIds[i][j];
        batchAttnMask[i * batchMaxLen + j] = batchPaddedMask[i][j];
      }
    }
    
    // Warmup
    await session.run({
      input_ids: new ort.Tensor('int64', batchInputIds, [batchTexts.length, batchMaxLen]),
      attention_mask: new ort.Tensor('int64', batchAttnMask, [batchTexts.length, batchMaxLen]),
    });
    
    // Benchmark 5 runs
    const start = Date.now();
    for (let run = 0; run < 5; run++) {
      await session.run({
        input_ids: new ort.Tensor('int64', batchInputIds, [batchTexts.length, batchMaxLen]),
        attention_mask: new ort.Tensor('int64', batchAttnMask, [batchTexts.length, batchMaxLen]),
      });
    }
    const elapsed = Date.now() - start;
    const totalEmbeddings = 5 * batchSize;
    const throughput = totalEmbeddings / (elapsed / 1000);
    
    console.log(`Batch size ${batchSize}: ${throughput.toFixed(2)} embeddings/sec (${(elapsed / totalEmbeddings * 1000).toFixed(0)}ms per embedding)`);
  }
}

benchmark().catch(console.error);
