/**
 * Local LLM API - uses Qwen3.6 on port 8082
 * Supports text, image, and video understanding (Qwen3.6 multimodal)
 * 
 * Model: Qwen3.6-35B-A3B (MoE, ~3.4B active params per token)
 * Quantization: Q4_K_XL
 * Performance: ~32-40 TPS (tokens per second)
 * VRAM: ~12-14GB
 */

const LLM_BASE = "http://localhost:8082/v1";
const DEFAULT_MODEL = "qwen3.6-35B-A3B-UD-Q4_K_XL.gguf";

export interface LocalLlmOptions {
	model?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxTokens?: number;
	/** Unused placeholder for future input-type discrimination */
	inputType?: string;
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
 * Check if local LLM is available
 */
export function isLocalLlmAvailable(): boolean {
	return true;
}
