import type { complete, Api, Model, ProviderHeaders } from "@earendil-works/pi-ai/compat";
import { resolveThinkingLevel, type SummaryGenerationContext } from "./summary-review.ts";
import { awaitWithAbort } from "./abortable.ts";
import { findModelWithProviderRouting, isModelInScope, resolveHelperModelSelector, type SummaryThinkingLevel } from "./summary-model-scope.ts";

async function resolveFirstAvailableModel(
	ctx: SummaryGenerationContext,
	candidates: Array<{ provider: string; id: string }>,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: ProviderHeaders }> {
	for (const { provider, id } of candidates) {
		const model = findModelWithProviderRouting(ctx.modelRegistry, provider, id);
		if (!model || !isModelInScope(model, ctx.scopedModels)) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return { model, apiKey: auth.apiKey, headers: auth.headers };
	}
	throw new Error(`No enabled model available: ${candidates.map(candidate => `${candidate.provider}/${candidate.id}`).join(", ")}`);
}

async function resolveConfiguredModel(
	ctx: SummaryGenerationContext,
	selector: string,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: ProviderHeaders; thinkingLevel?: SummaryThinkingLevel }> {
	const spec = resolveHelperModelSelector(selector, "query rewrite model", ctx.model);
	if (!spec) throw new Error(`Query rewrite model not found: ${selector} (no active Pi session model)`);
	const model = findModelWithProviderRouting(ctx.modelRegistry, spec.provider, spec.id);
	if (!model) throw new Error(`Query rewrite model not found: ${selector}`);
	const value = `${model.provider}/${model.id}`;
	if (!isModelInScope(model, ctx.scopedModels)) throw new Error(`Query rewrite model is not enabled: ${value}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`No API key available for query rewrite model ${value}`);
	return { model, apiKey: auth.apiKey, headers: auth.headers, thinkingLevel: spec.thinkingLevel };
}

export async function rewriteSearchQuery(
	query: string,
	ctx: SummaryGenerationContext,
	signal: AbortSignal,
	modelSelector?: string,
): Promise<string> {
	const { model, apiKey, headers, thinkingLevel }: Awaited<ReturnType<typeof resolveConfiguredModel>> = modelSelector === undefined
		? await resolveFirstAvailableModel(ctx, [
			{ provider: "anthropic", id: "claude-haiku-4-5" },
			{ provider: "google", id: "gemini-3.6-flash" },
			{ provider: "openai", id: "gpt-5-mini" },
		])
		: await resolveConfiguredModel(ctx, modelSelector);
	const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { complete?: typeof complete };
	// streamSimple is Pi's provider-neutral path and routes virtual models; complete() does not (#574).
	const usesRegistryStreamSimple = typeof registry.streamSimple === "function";
	const usesRegistryComplete = !usesRegistryStreamSimple && typeof registry.complete === "function";
	if (signal.aborted) throw new Error("Aborted");
	const compat = usesRegistryStreamSimple || usesRegistryComplete ? undefined : await awaitWithAbort(import("@earendil-works/pi-ai/compat"), signal);
	if (signal.aborted) throw new Error("Aborted");
	const requestedThinkingLevel = await awaitWithAbort(resolveThinkingLevel(model, thinkingLevel), signal);
	const reasoning = requestedThinkingLevel !== "off" ? requestedThinkingLevel : undefined;
	const context = {
		messages: [{
			role: "user" as const,
			content: [{ type: "text" as const, text: `Rewrite this web search query to get better, more specific results. Add relevant year qualifiers, precise technical terms, and specificity. Return ONLY the improved query text, nothing else.\n\nQuery: ${query}` }],
			timestamp: Date.now(),
		}],
	};
	const response = usesRegistryStreamSimple
		? await registry.streamSimple(model, context, { signal, ...(reasoning ? { reasoning } : {}) }).result()
		: usesRegistryComplete
			? await registry.complete!(model, context, {
				signal,
				...(requestedThinkingLevel ? { reasoning: requestedThinkingLevel } : {}),
				...(reasoning ? { reasoningEffort: reasoning } : {}),
			})
			: thinkingLevel
				? await compat!.completeSimple(model, context, { apiKey, headers, signal, ...(reasoning ? { reasoning } : {}) })
				: await compat!.complete(model, context, { apiKey, headers, signal });
	if (response.stopReason === "aborted") throw new Error("Aborted");
	const contentParts = Array.isArray(response.content) ? response.content : [];
	const text = contentParts
		.map((part: unknown) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
		.join("")
		.trim();
	if (!text) throw new Error("Rewrite returned empty response");
	return text;
}
