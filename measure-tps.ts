import { queryLocalLlm } from './local-llm-api.js';

// Measure TPS with different settings
async function measureTPS(prompt: string, model: string, maxTokens: number): Promise<{ tps: number; duration: number }> {
  const start = Date.now();
  const result = await queryLocalLlm(prompt, {
    model,
    maxTokens,
    timeoutMs: 60000,
  });
  const duration = (Date.now() - start) / 1000;
  const tokens = Math.ceil(result.length / 4);
  const tps = tokens / duration;
  return { tps, duration };
}

const prompt = "Write a detailed summary of the stock market outlook for 2026. Include key trends, analyst predictions, and potential risks. Be comprehensive but concise.";

console.log("Measuring Qwen3.6 TPS...\n");

// Test with current settings
const result = await measureTPS(prompt, "qwen3.6-35B-A3B-UD-Q4_K_XL", 512);
console.log(`Current settings:`);
console.log(`  TPS: ${result.tps.toFixed(2)}`);
console.log(`  Duration: ${result.duration.toFixed(1)}s`);
console.log(`  Tokens: ${Math.ceil(result.result.length / 4)}`);
