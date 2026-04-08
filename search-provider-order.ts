export interface SearchProviderAvailability {
	exa: boolean;
	perplexity: boolean;
	gemini: boolean;
}

export type StableAutoSearchProvider = "exa" | "perplexity" | "gemini";

export function pickAutoProvider(
	available: SearchProviderAvailability,
): StableAutoSearchProvider | null {
	if (available.exa) return "exa";
	if (available.perplexity) return "perplexity";
	if (available.gemini) return "gemini";
	return null;
}
