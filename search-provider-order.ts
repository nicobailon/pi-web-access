export interface SearchProviderAvailability {
	openai?: boolean;
	exa: boolean;
	perplexity: boolean;
	gemini: boolean;
}

export interface AutoSearchRequestConstraints {
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
}

export type StableAutoSearchProvider = "openai" | "exa" | "perplexity" | "gemini";

export function isOpenAIAutoCompatible(
	constraints: AutoSearchRequestConstraints = {},
): boolean {
	if (constraints.recencyFilter) return false;
	if (constraints.domainFilter?.some((domain) => domain.trim().startsWith("-"))) return false;
	return true;
}

export function getAutoProviderOrder(
	available: SearchProviderAvailability,
	constraints: AutoSearchRequestConstraints = {},
): StableAutoSearchProvider[] {
	const order: StableAutoSearchProvider[] = [];
	if (available.openai && isOpenAIAutoCompatible(constraints)) order.push("openai");
	if (available.exa) order.push("exa");
	if (available.perplexity) order.push("perplexity");
	if (available.gemini) order.push("gemini");
	return order;
}

export function pickAutoProvider(
	available: SearchProviderAvailability,
	constraints: AutoSearchRequestConstraints = {},
): StableAutoSearchProvider | null {
	return getAutoProviderOrder(available, constraints)[0] ?? null;
}
