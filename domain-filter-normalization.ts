export function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

/**
 * Applies the shared include/exclude `domainFilter` to results from a provider
 * that has no server-side equivalent, so a filter never returns off-domain
 * results silently. Unparseable URLs are dropped when an include list is set.
 */
export function applyDomainFilter<T extends { url: string }>(results: T[], domainFilter: readonly string[] | undefined): T[] {
	if (!domainFilter?.length) return results;
	const includes: string[] = [];
	const excludes: string[] = [];
	for (const raw of domainFilter) {
		const normalized = normalizeDomain(raw);
		if (!normalized) continue;
		if (raw.trim().startsWith("-")) excludes.push(normalized);
		else includes.push(normalized);
	}
	if (!includes.length && !excludes.length) return results;
	return results.filter((result) => {
		let host: string;
		try {
			host = new URL(result.url).hostname.toLowerCase();
		} catch {
			return false;
		}
		const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
		if (excludes.some(matches)) return false;
		if (includes.length && !includes.some(matches)) return false;
		return true;
	});
}
