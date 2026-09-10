import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type WebSearchWorkflow = "none" | "summary-review" | "auto-summary";

export function resolveWebSearchWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {
	const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
	if (normalized === "auto-summary") return "auto-summary";
	if (!hasUI) return "none";
	if (normalized === "none") return "none";
	return "summary-review";
}

export class CuratorRunState {
	private autoApproveRemaining = false;

	approveRemainingSearches(): void {
		this.autoApproveRemaining = true;
	}

	reset(): void {
		this.autoApproveRemaining = false;
	}

	resolve(requestedWorkflow: unknown, configuredWorkflow: unknown, hasUI: boolean): WebSearchWorkflow {
		const inherited = requestedWorkflow === undefined;
		const workflow = resolveWebSearchWorkflow(
			inherited ? configuredWorkflow : requestedWorkflow,
			hasUI,
		);
		return inherited && this.autoApproveRemaining && workflow === "summary-review"
			? "auto-summary"
			: workflow;
	}
}

export function registerCuratorRunLifecycle(pi: Pick<ExtensionAPI, "on">): CuratorRunState {
	const state = new CuratorRunState();
	pi.on("before_agent_start", () => state.reset());
	pi.on("agent_settled", () => state.reset());
	pi.on("session_start", () => state.reset());
	pi.on("session_tree", () => state.reset());
	pi.on("session_shutdown", () => state.reset());
	return state;
}
