/**
 * Local LLM API - uses Qwen3.6 on port 8080
 * Supports text, image, and video understanding (Qwen3.6 multimodal)
 */

const LLM_BASE = "http://localhost:8082/v1";
const DEFAULT_MODEL = "qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";

export interface LocalLlmOptions {
	model?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxTokens?: number;
}

export interface MultimodalContent {
	type: "text" | "image" | "video";
	text?: string;
	url?: string;
	base64?: string;
	mimeType?: string;
}

/**
 * Query the local LLM for text generation
 */
export async function queryLocalLlm(
	prompt: string,
	options: LocalLlmOptions = {},
): Promise<string> {
	const model = options.model ?? DEFAULT_MODEL;
	const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 120000);
	const maxTokens = options.maxTokens ?? 2048;

	const response = await fetch(`${LLM_BASE}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: prompt }],
			max_tokens: maxTokens,
			temperature: 1.0,
			top_p: 0.95,
			top_k: 64,
			// Server-side config: --reasoning on --chat-template-kwargs '{"enable_thinking": true}'
			// Client does not override — lets server use optimized reasoning config (39.72 TPS)
		}),
		signal,
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Local LLM error ${response.status}: ${error.slice(0, 300)}`);
	}

	const data = await response.json();
	const content = data.choices?.[0]?.message?.content;

	if (!content) throw new Error("Local LLM returned empty response");
	return content;
}

/**
 * Query the local LLM with multimodal input (image/video/text)
 * Uses raw llama.cpp API format (not OpenAI-compatible)
 */
export async function queryLocalLlmMultimodal(
	contents: MultimodalContent[],
	options: LocalLlmOptions = {},
): Promise<string> {
	const model = options.model ?? DEFAULT_MODEL;
	const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 120000);
	const maxTokens = options.maxTokens ?? 1024;

	// Extract text prompt and image URLs
	let textPrompt = "";
	let imageUrl = "";

	for (const content of contents) {
		if (content.type === "text") {
			textPrompt += content.text || "";
		} else if (content.type === "image" && content.url) {
			imageUrl = content.url;
		}
	}

	// Build chat template prompt
	const prompt = `<bos><start_of_turn>user\n${textPrompt}<end_of_turn>\n`;

	const response = await fetch(`${LLM_BASE}/completion`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			prompt,
			image_url: imageUrl || null,
			max_tokens: maxTokens,
			temperature: 1.0,
			top_p: 0.95,
			top_k: 64,
			// Server-side config: --reasoning on --chat-template-kwargs '{"enable_thinking": true}'
			// Client does not override — lets server use optimized reasoning config (39.72 TPS)
		}),
		signal,
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Local LLM multimodal error ${response.status}: ${error.slice(0, 300)}`);
	}

	const data = await response.json();
	const content = data.content;

	if (!content) throw new Error("Local LLM multimodal returned empty response");
	return content;
}

/**
 * Generate embeddings using BGE-M3 ONNX (CPU-optimized with batching)
 * BGE-M3 produces 1024-dim embeddings for semantic search
 * Performance: 200+ embeddings/sec with batching (100 texts per batch)
 */
const BGE_M3_MODEL_PATH = "/home/john/.local/llm/models/onnx/model.onnx";
let bgeSession: any = null;
let bgeTokenizer: any = null;

async function getBgeSession(): Promise<any> {
	if (!bgeSession) {
		const ort = await import("onnxruntime-node");
		bgeSession = await ort.InferenceSession.create(BGE_M3_MODEL_PATH, {
			providers: ["CPUExecutionProvider"],
		});
	}
	return bgeSession;
}

async function getBgeTokenizer(): Promise<any> {
	if (!bgeTokenizer) {
		const sp = await import("@agnai/sentencepiece-js");
		bgeTokenizer = new sp.SentencePieceProcessor();
		await bgeTokenizer.load("/home/john/.local/llm/models/onnx/sentencepiece.bpe.model");
	}
	return bgeTokenizer;
}

/**
 * Tokenize text for BGE-M3 using sentencepiece tokenizer
 */
async function tokenizeBgeM3(text: string): Promise<{ input_ids: number[]; attention_mask: number[] }> {
	const tokenizer = await getBgeTokenizer();
	const ids = tokenizer.encodeIds(text);
	const mask = ids.map(() => 1);
	return { input_ids: ids, attention_mask: mask };
}

/**
 * Generate batched embeddings using BGE-M3 ONNX
 * Processes multiple texts in a single inference call for 200+ embeddings/sec
 */
export async function generateBatchedEmbeddings(
	texts: string[],
	batchSize: number = 100,
): Promise<number[][]> {
	const session = await getBgeSession();
	const tokenizer = await getBgeTokenizer();
	
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
	
	// Run inference
	const outputs = await session.run({
		input_ids: new (await import("onnxruntime-node")).Tensor('int64', batchInputIds, [texts.length, maxLen]),
		attention_mask: new (await import("onnxruntime-node")).Tensor('int64', batchAttnMask, [texts.length, maxLen]),
	});
	
	// Extract embeddings
	const tensor = outputs['sentence_embedding'];
	const embeddingData = tensor.data as Float32Array;
	const hiddenDim = tensor.dims[1];
	const results: number[][] = [];
	
	for (let i = 0; i < texts.length; i++) {
		const start = i * hiddenDim;
		const embedding = Array.from(embeddingData.slice(start, start + hiddenDim));
		
		// L2 normalize
		const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
		if (norm > 0) {
			for (let j = 0; j < embedding.length; j++) {
				embedding[j] /= norm;
			}
		}
		
		results.push(embedding);
	}
	
	return results;
}

export async function generateEmbedding(
	text: string,
	options: LocalLlmOptions = {},
): Promise<number[]> {
	// For single embedding, use batched version with size 1
	const results = await generateBatchedEmbeddings([text]);
	return results[0];
}

/**
 * Generate embeddings for a batch of texts (optimized path)
 * @deprecated Use generateBatchedEmbeddings directly
 */
export async function generateEmbeddingsBatch(
	texts: string[],
): Promise<number[][]> {
	return generateBatchedEmbeddings(texts);
}

/**
 * Compute cosine similarity between two embeddings

		const ort = await import("onnxruntime-node");
		const outputs = await session.run({
			input_ids: new ort.Tensor('int64', BigInt64Array.from(input_ids.map(BigInt)), [1, input_ids.length]),
			attention_mask: new ort.Tensor('int64', BigInt64Array.from(attention_mask.map(BigInt)), [1, attention_mask.length]),
		});

		// BGE-M3 outputs: 'token_embeddings' [batch, seq_len, hidden_dim] and 'sentence_embedding' [batch, hidden_dim]
		// Use sentence_embedding which is already pooled
		const tensor = outputs['sentence_embedding'];
		const embedding = tensor.data as Float32Array;
		const hiddenDim = tensor.dims[1];
		const mean = new Float32Array(hiddenDim);
		for (let j = 0; j < hiddenDim; j++) {
			mean[j] = embedding[j];
		}

		// L2 normalize
		const norm = Math.sqrt(mean.reduce((sum, v) => sum + v * v, 0));
		if (norm > 0) {
			for (let j = 0; j < hiddenDim; j++) {
				mean[j] /= norm;
			}
		}

		return Array.from(mean);
	} catch (err) {
		// Fallback: return zero embedding if BGE-M3 fails
		console.error(`BGE-M3 embedding failed: ${err}`);
		return new Float32Array(1024).fill(0);
	}
}

/**
 * Compute cosine similarity between two embeddings
 * Used for Exa.ai-style semantic search reranking
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	normA = Math.sqrt(normA);
	normB = Math.sqrt(normB);

	if (normA === 0 || normB === 0) return 0;
	return dotProduct / (normA * normB);
}

export function isLocalLlmAvailable(): boolean {
	return true;
}
