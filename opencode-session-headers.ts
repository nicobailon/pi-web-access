import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionManager = Pick<ExtensionContext, "sessionManager">["sessionManager"];

/**
 * Pi adds OpenCode attribution headers inside the main agent loop. Extension
 * side-calls dispatch directly, so they must add the same session attribution.
 */
export function openCodeSessionHeaders(model: Model<Api>, sessionManager: SessionManager): Record<string, string> | undefined {
	const isOpenCode = model.provider === "opencode"
		|| model.provider === "opencode-go"
		|| (() => {
			try {
				return new URL(String(model.baseUrl ?? "")).hostname === "opencode.ai";
			} catch {
				return false;
			}
		})();
	if (!isOpenCode) return undefined;
	const sessionId = sessionManager?.getSessionId?.();
	if (!sessionId) return undefined;
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}
