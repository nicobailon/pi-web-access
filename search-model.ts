/** Invocation-local search model diagnostics. Returned IDs are backend-reported,
 * not independent verification of the model that actually served a request. */
export type SearchModelMetadata = {
	requestedModel?: string;
	sentModel?: string;
	returnedModel?: string;
};

export function normalizeSearchModelOverride(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw new Error("web_search model must be a non-empty string containing an exact server model ID");
	}
	return value.trim();
}

/** Pick only present fields, keeping old records and no-override results unchanged. */
export function searchModelMetadata(value: SearchModelMetadata): SearchModelMetadata {
	return {
		...(value.requestedModel !== undefined ? { requestedModel: value.requestedModel } : {}),
		...(value.sentModel !== undefined ? { sentModel: value.sentModel } : {}),
		...(value.returnedModel !== undefined ? { returnedModel: value.returnedModel } : {}),
	};
}

export function searchModelSuccess(requestedModel: string | undefined, sentModel: string, returnedModel?: unknown): SearchModelMetadata {
	if (requestedModel === undefined) return {};
	return {
		requestedModel,
		sentModel,
		...(typeof returnedModel === "string" && returnedModel.trim() ? { returnedModel } : {}),
	};
}

export class SearchModelOverrideError extends Error implements SearchModelMetadata {
	readonly requestedModel: string;
	readonly sentModel?: string;
	readonly provider: string;
	constructor(provider: string, requestedModel: string, cause: unknown, sentModel?: string) {
		super(`${provider} search (requested model ${JSON.stringify(requestedModel)}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		this.name = cause instanceof Error ? cause.name : "Error";
		this.provider = provider;
		this.requestedModel = requestedModel;
		if (sentModel !== undefined) this.sentModel = sentModel;
	}
}

/** Called only after the provider has redacted its credentials. */
export function searchModelFailure(error: unknown, provider: string, requestedModel: string | undefined, sentModel?: string): unknown {
	return requestedModel === undefined || error instanceof SearchModelOverrideError
		? error
		: new SearchModelOverrideError(provider, requestedModel, error, sentModel);
}

export function failedSearchModelMetadata(error: unknown, requestedModel?: string): SearchModelMetadata {
	return error instanceof SearchModelOverrideError
		? searchModelMetadata(error)
		: requestedModel !== undefined ? { requestedModel } : {};
}

/** Compact, explicitly labelled request/response diagnostics. */
export function formatSearchModel(value: SearchModelMetadata): string {
	const parts: string[] = [];
	if (value.sentModel) parts.push(`sent: ${value.sentModel}`);
	if (value.requestedModel && value.requestedModel !== value.sentModel) parts.push(`requested: ${value.requestedModel}`);
	if (value.returnedModel && value.returnedModel !== value.sentModel) parts.push(`returned: ${value.returnedModel}`);
	return parts.join("; ");
}
