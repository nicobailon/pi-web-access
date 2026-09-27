import { buildSessionContext, type ExtensionAPI, type ExtensionContext, type SessionContext } from "@earendil-works/pi-coding-agent";
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

function supportsDynamicTools(pi: ExtensionAPI): boolean {
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return false;
	// Pi 0.86.0 shipped transcript-backed tool changes in the same release that made pi.on() return
	// an unsubscribe function. Probe the host API object: an imported VERSION can come from a stale
	// Pi package installed beside this extension instead of the running host.
	const unsubscribe: unknown = pi.on("session_start", () => {});
	if (typeof unsubscribe !== "function") return false;
	unsubscribe();
	return true;
}

// Undefined when the transcript never declared tool changes.
function transcriptToolNames(messages: SessionContext["messages"]): Set<string> | undefined {
	let tools: Set<string> | undefined;
	for (const message of messages) {
		if (message.role !== "system" || !("toolsAdded" in message || "toolsRemoved" in message)) continue;
		tools ??= new Set();
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
	}
	return tools;
}

export function registerWebToolActivation(pi: ExtensionAPI, tools: ReadonlyArray<WebActivationTool>): void {
	if (tools.length === 0) return;
	if (!supportsDynamicTools(pi)) {
		console.warn("[pi-web-access] Dynamic tool activation requires Pi 0.86.0 or newer; web tools remain eagerly available.");
		return;
	}
	const names = tools.map(tool => tool.name);
	const capabilities = tools.map(tool => CAPABILITY_LABELS[tool.capability]).join(", ");

	const parameters = Type.Object({}, { additionalProperties: false });
	pi.registerTool<typeof parameters, Record<string, unknown>>({
		name: LOADER_NAME,
		label: "Enable Web Access",
		description: "Enable configured pi-web-access tools for web research and content retrieval. Does not search or fetch. Enabled tools are available on the next model request; disabled capabilities remain unavailable.",
		promptSnippet: `If tools for ${capabilities} are not already available, call web_enable first whenever current, external, or linked information could help; the tools appear on the next model request.`,
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
	function selectFromSession(ctx: ExtensionContext): void {
		if (!loaderAvailable()) return;
		try {
			const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
			// Sessions from before transcript tool declarations keep every web tool; fresh ones start with none.
			const recorded = transcriptToolNames(messages) ?? new Set(messages.length > 0 ? names : []);
			const others = pi.getActiveTools().filter(name => !names.includes(name));
			pi.setActiveTools([...new Set([...others, ...names.filter(name => recorded.has(name)), LOADER_NAME])]);
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
