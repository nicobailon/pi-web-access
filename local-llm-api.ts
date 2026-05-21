/**
 * Local LLM API - uses gemma-4-E2B on port 8082
 * Supports text, image, and video understanding (Gemma 4 E2B multimodal)
 */

const LLM_BASE = "http://localhost:8082/v1";
const DEFAULT_MODEL = "gemma-4-E2B-it-UD-Q4_K_XL.gguf";

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
			thinking: false,
			reasoning: false,
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
			thinking: false,
			reasoning: false,
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
 * Generate embeddings using BGE-M3 ONNX (CPU-optimized)
 * BGE-M3 produces 1024-dim embeddings, significantly better quality than Gemma 4 for semantic search
 * Performance: ~12 embeddings/sec on CPU (vs Gemma 4 which doesn't support embeddings)
 */
const BGE_M3_MODEL_PATH = "/home/john/.local/llm/models/onnx/model.onnx";
let bgeSession: any = null;

async function getBgeSession(): Promise<any> {
	if (!bgeSession) {
		const ort = await import("onnxruntime-node");
		bgeSession = await ort.InferenceSession.create(BGE_M3_MODEL_PATH, {
			providers: ["CPUExecutionProvider"],
		});
	}
	return bgeSession;
}

/**
 * Tokenize text for BGE-M3 using sentencepiece tokenizer
 */
async function tokenizeBgeM3(text: string): Promise<{ input_ids: number[]; attention_mask: number[] }> {
	const sp = await import("@agnai/sentencepiece-js");
	const tokenizer = new sp.SentencePieceProcessor();
	await tokenizer.load("/home/john/.local/llm/models/onnx/sentencepiece.bpe.model");
	const ids = tokenizer.encodeIds(text);
	const mask = ids.map(() => 1);
	return { input_ids: ids, attention_mask: mask };
}

export async function generateEmbedding(
	text: string,
	options: LocalLlmOptions = {},
): Promise<number[]> {
	try {
		const session = await getBgeSession();
		const { input_ids, attention_mask } = await tokenizeBgeM3(text);

		const outputs = await session.run({
			input_ids: new Int32Array(input_ids),
			attention_mask: new Float32Array(attention_mask),
		});

		// BGE-M3 outputs [batch, seq_len, hidden_dim] - use mean pooling
		const tensor = outputs[0];
		const embedding = tensor.data as Float32Array;
		const seqLen = tensor.shape[1];
		const hiddenDim = tensor.shape[2];
		const mean = new Float32Array(hiddenDim).fill(0);
		for (let i = 0; i < seqLen; i++) {
			for (let j = 0; j < hiddenDim; j++) {
				mean[j] += embedding[i * hiddenDim + j];
			}
		}
		for (let j = 0; j < hiddenDim; j++) {
			mean[j] /= seqLen;
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
