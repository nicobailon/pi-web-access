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

// Mirrors pi-ai's per-API transcript handling: without these flags, Pi resends the whole transcript
// as a checkpoint when web_enable changes the tools and prompt, which can miss the prompt cache.
function addsToolsWithoutCheckpoint(model: ExtensionContext["model"]): boolean {
	const compat = model?.compat as {
		supportsMidConvoSystemMessages?: boolean;
		supportsMidConvoToolChanges?: boolean;
		supportsMidConvoToolAdditions?: boolean;
		supportsAdditionalTools?: boolean;
		supportsToolSearch?: boolean;
	} | undefined;
	if (!model || compat?.supportsMidConvoSystemMessages !== true) return false;
	switch (model.api) {
		case "anthropic-messages": return compat.supportsMidConvoToolChanges === true;
		case "openai-completions": return compat.supportsMidConvoToolAdditions === true;
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses": return compat.supportsAdditionalTools === true || compat.supportsToolSearch === true;
		default: return false;
	}
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

export function registerWebToolActivation(pi: ExtensionAPI, tools: ReadonlyArray<WebActivationTool>, mode: "auto" | "dynamic"): void {
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
	// A resumed transcript that declared its tools without the loader keeps that set; adding the
	// loader there would record a mid-conversation tool change the user never asked for (#462).
	let loaderSelected = true;
	function selectFromSession(ctx: ExtensionContext): void {
		if (!loaderAvailable()) return;
		try {
			const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
			const declared = transcriptToolNames(messages);
			// "auto" decides once, for a fresh session; recorded sessions keep their tools.
			const eager = mode === "auto" && !declared && messages.length === 0 && !addsToolsWithoutCheckpoint(ctx.model);
			// Sessions from before transcript tool declarations keep every web tool; fresh ones start with none.
			const recorded = declared ?? new Set(messages.length > 0 || eager ? names : []);
			loaderSelected = !eager && (!declared || declared.has(LOADER_NAME));
			const others = pi.getActiveTools().filter(name => name !== LOADER_NAME && !names.includes(name));
			pi.setActiveTools([...new Set([...others, ...names.filter(name => recorded.has(name)), ...(loaderSelected ? [LOADER_NAME] : [])])]);
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
		if (!loaderSelected || !loaderAvailable() || pi.getActiveTools().includes(LOADER_NAME)) return;
		try {
			pi.setActiveTools([...pi.getActiveTools(), LOADER_NAME]);
		} catch {
			// Best effort: preserve the current selection if Pi rejects the update.
		}
	});
}
