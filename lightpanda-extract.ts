/**
 * LightPanda Content Extraction
 * Uses LightPanda for JS-rendered content extraction
 * 
 * LightPanda is a headless browser that can:
 * - Render JavaScript-heavy pages (SPAs, React, Vue, Angular)
 * - Extract clean markdown from rendered HTML
 * - Handle anti-bot measures
 * - Process Next.js RSC (React Server Components)
 * 
 * Speed: 200-500ms per URL
 */

import { exec } from "child_process";
import { promisify } from "util";
import { activityMonitor } from "./activity.js";

const execAsync = promisify(exec);
const LIGHTPANDA_BIN = "/home/john/.local/bin/lightpanda";

export interface LightPandaResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

/**
 * Extract content from a URL using LightPanda
 * Returns markdown content from the rendered page
 */
export async function extractWithLightPanda(
	url: string,
	signal?: AbortSignal,
): Promise<LightPandaResult | null> {
	const activityId = activityMonitor.logStart({ type: "api", query: `lightpanda: ${url}` });

	try {
		// Use LightPanda to fetch and extract markdown
		const { stdout, stderr } = await execAsync(
			`${LIGHTPANDA_BIN} fetch --dump markdown "${url}"`,
			{
				timeout: 30000,
				signal: signal as any,
			},
		);

		// Parse the markdown output
		const content = stdout.trim();
		
		if (!content || content.length < 100) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		// Extract title from markdown (first heading)
		const titleMatch = content.match(/^#{1,2}\s+(.+)$/m);
		const title = titleMatch ? titleMatch[1].replace(/\*+/g, "").trim() : new URL(url).hostname;

		activityMonitor.logComplete(activityId, 200);

		return {
			url,
			title,
			content,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
			return null;
		}

		activityMonitor.logError(activityId, message);
		
		// Return null to indicate LightPanda failed, caller will try fallbacks
		return null;
	}
}

/**
 * Extract HTML from a URL using LightPanda (raw HTML, not markdown)
 */
export async function extractWithLightPandaHTML(
	url: string,
	signal?: AbortSignal,
): Promise<{ url: string; html: string; error: string | null } | null> {
	const activityId = activityMonitor.logStart({ type: "api", query: `lightpanda-html: ${url}` });

	try {
		const { stdout } = await execAsync(
			`${LIGHTPANDA_BIN} fetch --dump html "${url}"`,
			{
				timeout: 30000,
				signal: signal as any,
			},
		);

		const html = stdout.trim();
		
		if (!html || html.length < 100) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}

		activityMonitor.logComplete(activityId, 200);

		return {
			url,
			html,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
			return null;
		}

		activityMonitor.logError(activityId, message);
		return null;
	}
}
