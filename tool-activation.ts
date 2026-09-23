import { buildSessionContext, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type WebCapability = "search" | "source-check" | "fetch" | "stored-content";

export interface WebActivationTool {
	name: string;
	capability: WebCapability;
}

const LOADER_NAME = "web_enable";
const CAPABILITY_LABELS: Record<WebCapability, string> = {
	search: "web search",
	"source-check": "source checking",
	fetch: "content fetching",
	"stored-content": "stored-result retrieval",
};

export function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
	const [major, minor, patch] = version.split(".").map(part => Number.parseInt(part, 10));
	if (![major, minor, patch].every(Number.isFinite)) return false;
	const [minMajor, minMinor, minPatch] = minimum;
	if (major !== minMajor) return major > minMajor;
	if (minor !== minMinor) return minor > minMinor;
	return patch >= minPatch;
}

function supportsDynamicTools(pi: ExtensionAPI): boolean {
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return false;
	// Read the version from the running Pi module. Resolving the package on disk fails
	// for the single-file binary, which has no `@earendil-works/pi-coding-agent` install
	// for extension imports to resolve against.
	return typeof VERSION === "string" && versionAtLeast(VERSION, [0, 86, 1]);
}

async function loadCurrentToolsGetter(): Promise<(messages: unknown[]) => Array<{ name: string }>> {
	// The package root re-exports `getCurrentTools`. Prefer it over the subpath export,
	// which older and bundled Pi builds fail to resolve from extension code.
	const candidates = ["@earendil-works/pi-ai", "@earendil-works/pi-ai/utils/transcript"];
	const failures: string[] = [];
	for (const specifier of candidates) {
		try {
			const module: { getCurrentTools?: (messages: unknown[]) => Array<{ name: string }> } = await import(specifier);
			if (typeof module.getCurrentTools === "function") return module.getCurrentTools;
			failures.push(`${specifier} exports no getCurrentTools`);
		} catch (error) {
			failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`getCurrentTools is unavailable (${failures.join("; ")})`);
}

function hasToolDeclarations(messages: unknown[]): boolean {
	return messages.some(message => message && typeof message === "object" && (
		"toolsAdded" in message || "toolsRemoved" in message
	));
}

async function currentTranscriptToolNames(messages: unknown[]): Promise<string[]> {
	const getCurrentTools = await loadCurrentToolsGetter();
	return getCurrentTools(messages).map(tool => tool.name);
}

export function registerWebToolActivation(pi: ExtensionAPI, tools: ReadonlyArray<WebActivationTool>): void {
	if (tools.length === 0) return;
	if (!supportsDynamicTools(pi)) {
		console.warn(`[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer (running ${VERSION}); web tools remain eagerly available.`);
		return;
	}
	const names = tools.map(tool => tool.name);
	const capabilities = tools.map(tool => CAPABILITY_LABELS[tool.capability]).join(", ");

	const parameters = Type.Object({}, { additionalProperties: false });
	pi.registerTool<typeof parameters, Record<string, unknown>>({
		name: LOADER_NAME,
		label: "Enable Web Access",
		description: "Enable configured pi-web-access tools for web research and content retrieval. Does not search or fetch. Enabled tools are available on the next model request; disabled capabilities remain unavailable.",
		promptSnippet: `pi-web-access is configured for ${capabilities}. Call web_enable to activate these tools; use them on the next model request.`,
		parameters,
		async execute() {
			const registered = new Set(pi.getAllTools().map(tool => tool.name));
			const unavailable = names.filter(name => !registered.has(name));
			if (unavailable.length > 0) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Cannot enable unavailable tools: ${unavailable.join(", ")}.` }],
					details: { unavailable },
				};
			}

			try {
				pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Activation failed: ${message}.` }],
					details: { error: message },
				};
			}

			const active = new Set(pi.getActiveTools());
			const missing = names.filter(name => !active.has(name));
			return missing.length > 0
				? {
					isError: true,
					content: [{ type: "text" as const, text: `Tools still inactive after activation: ${missing.join(", ")}.` }],
					details: { missing },
				}
				: {
					content: [{ type: "text" as const, text: `Enabled: ${names.join(", ")}.` }],
					details: { enabled: names },
				};
		},
	});

	function loaderAvailable(): boolean {
		return pi.getAllTools().some(tool => tool.name === LOADER_NAME);
	}

	let warned = false;
	async function selectFromSession(ctx: ExtensionContext): Promise<void> {
		if (!loaderAvailable()) return;
		try {
			const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
			const recorded = hasToolDeclarations(messages)
				? new Set(await currentTranscriptToolNames(messages))
				: messages.length > 0
					? new Set(names)
					: new Set<string>();
			const heavy = new Set(names);
			const active = pi.getActiveTools().filter(name => !heavy.has(name));
			for (const name of names) if (recorded.has(name)) active.push(name);
			pi.setActiveTools([...new Set([...active, LOADER_NAME])]);
		} catch (error) {
			if (!warned) {
				warned = true;
				console.warn(`[pi-web-access] Keeping web tools eagerly available because activation setup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => selectFromSession(ctx));
	pi.on("session_tree", (_event, ctx) => selectFromSession(ctx));
	pi.on("before_agent_start", () => {
		if (!loaderAvailable() || pi.getActiveTools().includes(LOADER_NAME)) return;
		try {
			pi.setActiveTools([...pi.getActiveTools(), LOADER_NAME]);
		} catch {
			// Best effort: preserve the current selection if Pi rejects the update.
		}
	});
}
