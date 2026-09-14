export type FindMode = "exact" | "case-insensitive" | "fuzzy";

const CONTEXT_CHARS = 400;
const MAX_OUTPUT_CHARS = 20_000;

interface Match {
	query: string;
	start: number;
	end: number;
}

interface Range {
	start: number;
	end: number;
}

function normalize(value: string): string {
	return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function editDistanceWithin(left: string, right: string, maximum: number): boolean {
	if (Math.abs(left.length - right.length) > maximum) return false;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		let rowMinimum = i;
		for (let j = 1; j <= right.length; j++) {
			const value = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
			current[j] = value;
			rowMinimum = Math.min(rowMinimum, value);
		}
		if (rowMinimum > maximum) return false;
		previous = current;
	}
	return (previous[right.length] ?? maximum + 1) <= maximum;
}

function literalMatches(text: string, query: string, caseInsensitive: boolean): Match[] {
	const haystack = caseInsensitive ? text.toLocaleLowerCase() : text;
	const needle = caseInsensitive ? query.toLocaleLowerCase() : query;
	const matches: Match[] = [];
	for (let start = haystack.indexOf(needle); start >= 0; start = haystack.indexOf(needle, start + Math.max(needle.length, 1))) {
		matches.push({ query, start, end: start + query.length });
	}
	return matches;
}

function fuzzyMatches(text: string, query: string): Match[] {
	const queryTokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
	if (queryTokens.length === 0) return [];
	const matches: Match[] = [];
	const paragraphs = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
	for (const paragraph of text.matchAll(paragraphs)) {
		const paragraphText = paragraph[0];
		if (paragraphText.trim().length === 0 || paragraph.index === undefined) continue;
		const tokens = [...paragraphText.matchAll(/[\p{L}\p{N}]+/gu)];
		const matched = queryTokens.filter(queryToken => tokens.some(token => {
			const candidate = normalize(token[0]);
			const maximum = queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0;
			return editDistanceWithin(queryToken, candidate, maximum);
		}));
		const required = queryTokens.length === 1 ? 1 : Math.ceil(queryTokens.length * 0.6);
		if (matched.length < required) continue;
		const first = tokens.find(token => matched.some(queryToken => {
			const maximum = queryToken.length >= 9 ? 2 : queryToken.length >= 5 ? 1 : 0;
			return editDistanceWithin(queryToken, normalize(token[0]), maximum);
		}));
		const start = paragraph.index + (first?.index ?? 0);
		matches.push({ query, start, end: start + (first?.[0].length ?? query.length) });
	}
	return matches;
}

function mergeRanges(ranges: Range[]): Range[] {
	const merged: Range[] = [];
	for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

function contextRanges(textLength: number, matches: Match[]): Range[] {
	const ranges: Range[] = [];
	for (const match of matches) {
		ranges.push({
			start: Math.max(0, match.start - CONTEXT_CHARS),
			end: Math.min(textLength, match.end + CONTEXT_CHARS),
		});
	}
	return mergeRanges(ranges);
}

function lowerBound(values: number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? 0) < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

function upperBound(values: number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? 0) <= target) low = middle + 1;
		else high = middle;
	}
	return low;
}

export function findContent(
	text: string,
	queries: string[],
	mode: FindMode,
): { text: string; matchCount: number; returnedMatches: number; queryResults: Array<{ query: string; matchCount: number }> } {
	const normalizedQueries = [...new Set(queries.map(query => query.trim()).filter(Boolean))];
	const occurrences = normalizedQueries.map(query => {
		const matches = mode === "fuzzy" ? fuzzyMatches(text, query) : literalMatches(text, query, mode === "case-insensitive");
		return { query, matches, starts: matches.map(match => match.start), ends: matches.map(match => match.end) };
	});
	const matches = occurrences.flatMap(result => result.matches);
	const queryResults = occurrences.map(result => ({ query: result.query, matchCount: result.matches.length }));

	const heading = matches.length > 0 ? `Text matches (${mode})` : `Text matches (${mode}): no matches`;
	const missing = queryResults.filter(result => result.matchCount === 0).map(result => `\"${result.query}\"`);
	const matchingQueries = occurrences.filter(result => result.matches.length > 0).map((result, index) => ({
		...result,
		id: `Q${index + 1}`,
		order: index,
	}));
	const whitespaceRuns = [...text.matchAll(/\s+/g)].map(run => ({ start: run.index, end: run.index + run[0].length }));
	const whitespaceStarts = whitespaceRuns.map(run => run.start);
	const whitespaceEnds = whitespaceRuns.map(run => run.end);
	const whitespaceSavings = [0];
	for (const run of whitespaceRuns) whitespaceSavings.push((whitespaceSavings.at(-1) ?? 0) + run.end - run.start - 1);
	function normalizedLength(start: number, end: number): number {
		const firstRun = upperBound(whitespaceStarts, start) - 1;
		if (firstRun >= 0 && (whitespaceEnds[firstRun] ?? 0) > start) start = whitespaceEnds[firstRun] ?? start;
		if (start >= end) return 0;
		const lastRun = upperBound(whitespaceStarts, end - 1) - 1;
		if (lastRun >= 0 && (whitespaceEnds[lastRun] ?? 0) >= end) end = whitespaceStarts[lastRun] ?? end;
		if (start >= end) return 0;
		const first = lowerBound(whitespaceStarts, start);
		const last = upperBound(whitespaceEnds, end);
		return end - start - ((whitespaceSavings[last] ?? 0) - (whitespaceSavings[first] ?? 0));
	}
	function rangeCounts(range: Range) {
		// Literal occurrences have fixed widths; fuzzy occurrences come from successive disjoint paragraphs.
		return matchingQueries.flatMap(result => {
			const first = lowerBound(result.starts, range.start);
			const last = upperBound(result.ends, range.end);
			return last > first ? [{ ...result, count: last - first, firstStart: result.starts[first] ?? 0 }] : [];
		}).sort((left, right) => left.firstStart - right.firstStart || left.order - right.order);
	}
	const legend = matchingQueries.length > 0
		? `Queries: ${matchingQueries.map(result => `${result.id} = \"${result.query}\"`).join(", ")}`
		: "";
	const missingNotice = missing.length > 0 ? `No matches: ${missing.join(", ")}` : "";
	function measure(ranges: Range[], overflow = false, omitted: string[] = []) {
		let length = heading.length;
		let returnedMatches = 0;
		if (overflow && legend) length += 2 + legend.length;
		for (const [index, range] of ranges.entries()) {
			const counts = rangeCounts(range);
			if (counts.length === 0) continue;
			const labelsLength = counts.reduce((total, result) => total
				+ (overflow ? result.id.length : result.query.length + 2)
				+ 2 + String(result.count).length, 2 * (counts.length - 1));
			const snippetLength = normalizedLength(range.start, range.end)
				+ (range.start > 0 ? 1 : 0) + (range.end < text.length ? 1 : 0);
			length += 2 + String(index + 1).length + 2 + labelsLength + 1 + snippetLength;
			returnedMatches += counts.reduce((total, result) => total + result.count, 0);
		}
		if (missingNotice) length += 2 + missingNotice.length;
		if (omitted.length > 0) length += 2 + `No representative excerpt: ${omitted.join(", ")}.`.length;
		if (returnedMatches < matches.length) length += 2 + `Showing ${returnedMatches} of ${matches.length} matches.`.length;
		return { length, returnedMatches };
	}
	function formatRanges(ranges: Range[], overflow = false, omitted: string[] = []) {
		const sections = [heading];
		let returnedMatches = 0;
		if (overflow && legend) sections.push(legend);
		for (const [index, range] of ranges.entries()) {
			const contained = rangeCounts(range);
			if (contained.length === 0) continue;
			const prefix = range.start > 0 ? "…" : "";
			const suffix = range.end < text.length ? "…" : "";
			const snippet = `${prefix}${text.slice(range.start, range.end).replace(/\s+/g, " ").trim()}${suffix}`;
			const counts = contained
				.map(result => `${overflow ? result.id : `\"${result.query}\"`} ×${result.count}`)
				.join(", ");
			sections.push(`${index + 1}. ${counts}\n${snippet}`);
			returnedMatches += contained.reduce((total, result) => total + result.count, 0);
		}
		if (missingNotice) sections.push(missingNotice);
		if (omitted.length > 0) sections.push(`No representative excerpt: ${omitted.join(", ")}.`);
		if (returnedMatches < matches.length) sections.push(`Showing ${returnedMatches} of ${matches.length} matches.`);
		return { text: sections.join("\n\n"), matchCount: matches.length, returnedMatches, queryResults };
	}

	const fullRanges = contextRanges(text.length, matches);
	const full = measure(fullRanges);
	if (full.returnedMatches === matches.length && full.length <= MAX_OUTPUT_CHARS) return formatRanges(fullRanges);

	let ranges: Range[] = [];
	let omitted = matchingQueries.map(result => result.id);
	if (measure(ranges, true, omitted).length > MAX_OUTPUT_CHARS) {
		const text = `${heading}\n\nUnable to format bounded excerpts: query metadata exceeds ${MAX_OUTPUT_CHARS} characters.\n\nShowing 0 of ${matches.length} matches.`;
		return { text, matchCount: matches.length, returnedMatches: 0, queryResults };
	}
	const witnesses: Match[] = [];
	for (const { id, matches: queryMatches } of matchingQueries) {
		const proposedOmitted = omitted.filter(queryId => queryId !== id);
		const currentLength = measure(ranges, true, omitted).length;
		let selected: { witness: Match; ranges: Range[]; cost: number } | undefined;
		for (const witness of queryMatches) {
			const proposedRanges = mergeRanges([...ranges, { start: witness.start, end: witness.end }]);
			const summary = measure(proposedRanges, true, proposedOmitted);
			const candidate = {
				witness,
				ranges: proposedRanges,
				cost: summary.length - currentLength,
			};
			if (summary.length <= MAX_OUTPUT_CHARS && (!selected || candidate.cost < selected.cost
				|| candidate.cost === selected.cost && (witness.start < selected.witness.start
					|| witness.start === selected.witness.start && witness.end < selected.witness.end))) selected = candidate;
		}
		if (selected) {
			ranges = selected.ranges;
			omitted = proposedOmitted;
			witnesses.push(selected.witness);
		}
	}
	for (const witness of witnesses) {
		const proposed = mergeRanges([...ranges, {
			start: Math.max(0, witness.start - CONTEXT_CHARS),
			end: Math.min(text.length, witness.end + CONTEXT_CHARS),
		}]);
		if (measure(proposed, true, omitted).length <= MAX_OUTPUT_CHARS) ranges = proposed;
	}
	const allOccurrences = mergeRanges([...ranges, ...matches.map(match => ({ start: match.start, end: match.end }))]);
	if (measure(allOccurrences, true, omitted).length <= MAX_OUTPUT_CHARS) ranges = allOccurrences;
	return formatRanges(ranges, true, omitted);
}
