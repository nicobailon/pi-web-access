import { execFileSync, exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtractedContent } from "./extract.js";

const execAsync = promisify(exec);

export interface BrowserStealthOptions {
	launchMode?: boolean;
	timeoutMs?: number;
}

interface BrowserStealthConfig {
	enabled: boolean;
	launchMode: boolean;
	timeoutMs: number;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

export function isBrowserStealthAvailable(options?: BrowserStealthOptions): boolean {
	const launchMode = options?.launchMode ?? false;

	// Check if agent-browser-stealth or abs CLI is available
	try {
		execFileSync("which", ["agent-browser-stealth"], { timeout: 2000 });
		return true;
	} catch {
		// Try abs shortcut
		try {
			execFileSync("which", ["abs"], { timeout: 2000 });
			return true;
		} catch {
			return false;
		}
	}
}

function getStealthCommand(): string {
	try {
		execFileSync("which", ["agent-browser-stealth"], { timeout: 2000 });
		return "agent-browser-stealth";
	} catch {
		return "abs";
	}
}

export async function stealthNavigate(url: string, options?: BrowserStealthOptions): Promise<boolean> {
	const cmd = getStealthCommand();
	const launchFlag = (options?.launchMode ?? false) ? "--launch " : "";

	try {
		await execAsync(`${launchFlag}${cmd} open "${url}"`, {
			timeout: options?.timeoutMs ?? 30000,
		});
		return true;
	} catch (err) {
		console.error(`[browser-stealth] Failed to navigate to ${url}: ${errorMessage(err)}`);
		return false;
	}
}

export async function stealthSnapshot(options?: BrowserStealthOptions): Promise<string | null> {
	const cmd = getStealthCommand();
	const launchFlag = (options?.launchMode ?? false) ? "--launch " : "";

	try {
		const { stdout } = await execAsync(`${launchFlag}${cmd} snapshot -i --json`, {
			timeout: options?.timeoutMs ?? 30000,
		});
		return stdout.trim() || null;
	} catch (err) {
		console.error(`[browser-stealth] Failed to snapshot: ${errorMessage(err)}`);
		return null;
	}
}

export async function stealthText(selector: string, options?: BrowserStealthOptions): Promise<string | null> {
	const cmd = getStealthCommand();
	const launchFlag = (options?.launchMode ?? false) ? "--launch " : "";

	try {
		const { stdout } = await execAsync(`${launchFlag}${cmd} get text ${selector}`, {
			timeout: options?.timeoutMs ?? 30000,
		});
		return stdout.trim() || null;
	} catch (err) {
		console.error(`[browser-stealth] Failed to get text: ${errorMessage(err)}`);
		return null;
	}
}

export async function stealthPageContent(options?: BrowserStealthOptions): Promise<string | null> {
	const cmd = getStealthCommand();
	const launchFlag = (options?.launchMode ?? false) ? "--launch " : "";

	try {
		// Use snapshot with depth to get full page content
		const { stdout } = await execAsync(`${launchFlag}${cmd} snapshot -d 5`, {
			timeout: options?.timeoutMs ?? 60000,
		});
		return stdout.trim() || null;
	} catch (err) {
		console.error(`[browser-stealth] Failed to get page content: ${errorMessage(err)}`);
		return null;
	}
}

export async function stealthUrl(options?: BrowserStealthOptions): Promise<string | null> {
	const cmd = getStealthCommand();
	const launchFlag = (options?.launchMode ?? false) ? "--launch " : "";

	try {
		const { stdout } = await execAsync(`${launchFlag}${cmd} get url`, {
			timeout: options?.timeoutMs ?? 10000,
		});
		return stdout.trim() || null;
	} catch (err) {
		console.error(`[browser-stealth] Failed to get URL: ${errorMessage(err)}`);
		return null;
	}
}

export async function stealthTitle(options?: BrowserStealthOptions): Promise<string | null> {
	const cmd = getStealthCommand();
	const launchFlag = (options?.launchMode ?? false) ? "--launch " : "";

	try {
		const { stdout } = await execAsync(`${launchFlag}${cmd} get title`, {
			timeout: options?.timeoutMs ?? 10000,
		});
		return stdout.trim() || null;
	} catch (err) {
		console.error(`[browser-stealth] Failed to get title: ${errorMessage(err)}`);
		return null;
	}
}

export async function extractViaBrowserStealth(
	url: string,
	signal?: AbortSignal,
	options?: BrowserStealthOptions,
): Promise<ExtractedContent | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), options?.timeoutMs ?? 60000);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		// Navigate to URL
		const navigated = await stealthNavigate(url, { ...options, launchMode: options?.launchMode ?? false });
		if (!navigated) return null;

		// Wait a moment for page to load
		await new Promise(r => setTimeout(r, 2000));

		// Get page content
		const content = await stealthPageContent(options);
		if (!content || content.length < 100) return null;

		// Get title
		const title = await stealthTitle(options);

		return {
			url,
			title: title ?? "Page Content",
			content,
			error: null,
		};
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			return { url, title: "", content: "", error: "Aborted" };
		}
		return { url, title: "", content: "", error: `Browser stealth failed: ${message}` };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}
