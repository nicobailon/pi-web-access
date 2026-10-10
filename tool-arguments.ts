// Some models send array arguments as a JSON string, for example
// `provider: "[\"parallel-mcp\"]"`, which fails schema validation before the tool
// runs. Parse such strings back into arrays of strings; leave anything else as is.
export function parseStringifiedArrays(args: unknown, keys: readonly string[]): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const input = args as Record<string, unknown>;
	let output: Record<string, unknown> | undefined;
	for (const key of keys) {
		const value = input[key];
		if (typeof value !== "string" || !value.trim().startsWith("[")) continue;
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
				output ??= { ...input };
				output[key] = parsed;
			}
		} catch {
			throw new Error(`${key} must be an array of strings; the given value is not valid JSON`);
		}
	}
	return output ?? args;
}
