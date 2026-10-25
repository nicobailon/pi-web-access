const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type SummaryThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelLike {
	provider: string;
	id: string;
}

export interface ModelRegistryLike<T extends ModelLike = ModelLike> {
	find(provider: string, id: string): T | undefined;
	getAvailable(): readonly T[];
}

/**
 * Resolve a model through its native provider or a provider that routes that model ID.
 *
 * The direct registry fallback preserves explicit/native model resolution when a
 * provider's availability snapshot does not include the configured model. Callers
 * continue to apply their existing enabled-model and authentication checks.
 */
export function findModelWithProviderRouting<T extends ModelLike>(
	registry: ModelRegistryLike<T>,
	provider: string,
	id: string,
): T | undefined {
	const available = registry.getAvailable();
	const direct = available.find(model => model.provider === provider && model.id === id);
	if (direct) return direct;

	const routedId = `${provider}/${id}`;
	// If multiple routers expose the same model ID, Pi's available-model ordering
	// determines which route is selected. An explicit provider/model selector can
	// select a specific route when that distinction matters.
	const routed = available.find(model => model.id === routedId);
	return routed ?? registry.find(provider, id);
}

/**
 * Pi resolves `--models` and `enabledModels` against the available catalogue and exposes the
 * result as `ctx.scopedModels`; an empty scope means every available model is allowed.
 */
export function isModelInScope(model: ModelLike, scopedModels: ReadonlyArray<{ model: ModelLike }>): boolean {
	return scopedModels.length === 0 || scopedModels.some(scoped => scoped.model.provider === model.provider && scoped.model.id === model.id);
}

export function splitThinkingSuffix(value: string): { value: string; thinkingLevel?: SummaryThinkingLevel } {
	const index = value.lastIndexOf(":");
	if (index < 0) return { value };
	const suffix = value.slice(index + 1);
	return THINKING_LEVELS.has(suffix)
		? { value: value.slice(0, index), thinkingLevel: suffix as SummaryThinkingLevel }
		: { value };
}

export type HelperModelSelector =
	| { kind: "current"; thinkingLevel?: SummaryThinkingLevel }
	| { kind: "model"; provider: string; id: string; thinkingLevel?: SummaryThinkingLevel };

/** `current` names the active Pi session model; it has no `/`, so it cannot collide with provider/model-id. */
export function parseHelperModelSelector(value: string, label: string): HelperModelSelector {
	const selector = splitThinkingSuffix(value.trim());
	if (selector.value === "current") return { kind: "current", thinkingLevel: selector.thinkingLevel };
	const slashIndex = selector.value.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= selector.value.length - 1) {
		throw new Error(`Invalid ${label}: ${value}. Use provider/model-id or current.`);
	}
	return {
		kind: "model",
		provider: selector.value.slice(0, slashIndex),
		id: selector.value.slice(slashIndex + 1),
		thinkingLevel: selector.thinkingLevel,
	};
}

export function resolveHelperModelSpec(
	selector: HelperModelSelector,
	currentModel?: ModelLike,
): { provider: string; id: string; thinkingLevel?: SummaryThinkingLevel } | undefined {
	if (selector.kind === "model") return { provider: selector.provider, id: selector.id, thinkingLevel: selector.thinkingLevel };
	return currentModel ? { provider: currentModel.provider, id: currentModel.id, thinkingLevel: selector.thinkingLevel } : undefined;
}
