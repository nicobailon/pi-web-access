import { execFile } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";

export type CookieMap = Record<string, string>;

interface BrowserConfig {
	name: string;
	baseDir: string;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
}

const GOOGLE_ORIGINS = [
	"https://gemini.google.com",
	"https://accounts.google.com",
	"https://www.google.com",
];

const ALL_COOKIE_NAMES = new Set([
	"__Secure-1PSID",
	"__Secure-1PSIDTS",
	"__Secure-1PSIDCC",
	"__Secure-1PAPISID",
	"NID",
	"AEC",
	"SOCS",
	"__Secure-BUCKET",
	"__Secure-ENID",
	"SID",
	"HSID",
	"SSID",
	"APISID",
	"SAPISID",
	"__Secure-3PSID",
	"__Secure-3PSIDTS",
	"__Secure-3PAPISID",
	"SIDCC",
]);

const MACOS_BROWSER_CONFIGS: BrowserConfig[] = [
	{
		name: "Helium",
		baseDir: "Library/Application Support/net.imput.helium",
		keychainService: "Helium Storage Key",
		keychainAccount: "Helium",
	},
	{
		name: "Chrome",
		baseDir: "Library/Application Support/Google/Chrome",
		keychainService: "Chrome Safe Storage",
		keychainAccount: "Chrome",
	},
	{
		name: "Arc",
		baseDir: "Library/Application Support/Arc/User Data",
		keychainService: "Arc Safe Storage",
		keychainAccount: "Arc",
	},
];

const LINUX_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
	{ name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
];

const browserPasswordCache = new Map<string, string>();

export async function getGoogleCookies(
	options?: { profile?: string; requiredCookies?: string[] },
): Promise<{ cookies: CookieMap; warnings: string[] } | null> {
	const currentPlatform = platform();
	const configs = currentPlatform === "darwin"
		? MACOS_BROWSER_CONFIGS
		: currentPlatform === "linux"
			? LINUX_BROWSER_CONFIGS
			: [];
	if (configs.length === 0) return null;

	const warningSet = new Set<string>();
	const requestedProfile = normalizeProfileName(options?.profile);
	const requiredCookies = normalizeCookieNames(options?.requiredCookies);
	const hosts = GOOGLE_ORIGINS.map((origin) => new URL(origin).hostname);
	const home = homedir();

	for (const config of configs) {
		const profiles = requestedProfile ? [requestedProfile] : listBrowserProfiles(home, config);
		for (const profile of profiles) {
			const cookiesPath = join(home, config.baseDir, profile, "Cookies");
			if (!existsSync(cookiesPath)) continue;

			const tempDir = mkdtempSync(join(tmpdir(), "pi-chrome-cookies-"));
			try {
				const tempDb = join(tempDir, "Cookies");
				copyFileSync(cookiesPath, tempDb);
				copySidecar(cookiesPath, tempDb, "-wal");
				copySidecar(cookiesPath, tempDb, "-shm");

				if (requiredCookies && requiredCookies.length > 0) {
					// Cheap preflight: avoid touching Keychain/secret-tool until this profile actually
					// contains the cookie names Gemini Web needs. This prevents pointless password prompts
					// when the user is signed into Chrome but not into gemini.google.com in that profile.
					const hasRequiredCookies = await hasCookieNames(tempDb, hosts, requiredCookies);
					if (!hasRequiredCookies) continue;
				}

				const password = await readBrowserPassword(config, currentPlatform);
				if (!password) {
					warningSet.add(`Could not read ${config.name} cookie encryption password`);
					continue;
				}

				const key = pbkdf2Sync(password, "saltysalt", currentPlatform === "darwin" ? 1003 : 1, 16, "sha1");
				const metaVersion = await readMetaVersion(tempDb);
				const stripHash = metaVersion >= 24;
				const rows = await queryCookieRows(tempDb, hosts, ALL_COOKIE_NAMES);
				if (!rows) {
					warningSet.add(`Failed to query ${config.name} cookie database`);
					continue;
				}

				const cookies: CookieMap = {};
				for (const row of rows) {
					const name = row.name as string;
					if (!ALL_COOKIE_NAMES.has(name)) continue;
					if (cookies[name]) continue;

					let value = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
					if (!value) {
						const encrypted = row.encrypted_value;
						if (encrypted instanceof Uint8Array) {
							value = decryptCookieValue(encrypted, key, stripHash);
						}
					}
					if (value) cookies[name] = value;
				}

				if (requiredCookies && !requiredCookies.every((name) => Boolean(cookies[name]))) {
					continue;
				}

				return { cookies, warnings: [...warningSet] };
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	}

	return null;
}

function normalizeProfileName(value: string | undefined): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeCookieNames(names: string[] | undefined): string[] | undefined {
	if (!names?.length) return undefined;
	const normalized = names
		.filter((name): name is string => typeof name === "string" && name.length > 0)
		.map((name) => name.trim())
		.filter(Boolean);
	return normalized.length > 0 ? normalized : undefined;
}

function listBrowserProfiles(home: string, config: BrowserConfig): string[] {
	const basePath = join(home, config.baseDir);
	if (!existsSync(basePath)) return ["Default"];

	const profiles = new Set<string>();
	if (existsSync(join(basePath, "Default", "Cookies"))) profiles.add("Default");

	try {
		for (const entry of readdirSync(basePath, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (!existsSync(join(basePath, entry.name, "Cookies"))) continue;
			profiles.add(entry.name);
		}
	} catch {}

	const resolved = [...profiles];
	if (resolved.length === 0) return ["Default"];
	resolved.sort(compareProfileNames);
	return resolved;
}

function compareProfileNames(a: string, b: string): number {
	const aKey = getProfileSortKey(a);
	const bKey = getProfileSortKey(b);
	if (aKey.priority !== bKey.priority) return aKey.priority - bKey.priority;
	if (aKey.index !== bKey.index) return aKey.index - bKey.index;
	return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function getProfileSortKey(name: string): { priority: number; index: number } {
	if (name === "Default") return { priority: 0, index: 0 };
	const profileMatch = /^Profile\s+(\d+)$/i.exec(name);
	if (profileMatch) return { priority: 1, index: Number(profileMatch[1]) };
	const personMatch = /^Person\s+(\d+)$/i.exec(name);
	if (personMatch) return { priority: 2, index: Number(personMatch[1]) };
	return { priority: 3, index: Number.MAX_SAFE_INTEGER };
}

function decryptCookieValue(encrypted: Uint8Array, key: Buffer, stripHash: boolean): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.length < 3) return null;

	const prefix = buf.subarray(0, 3).toString("utf8");
	if (!/^v\d\d$/.test(prefix)) return null;

	const ciphertext = buf.subarray(3);
	if (!ciphertext.length) return "";

	try {
		const iv = Buffer.alloc(16, 0x20);
		const decipher = createDecipheriv("aes-128-cbc", key, iv);
		decipher.setAutoPadding(false);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		const unpadded = removePkcs7Padding(plaintext);
		const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		let i = 0;
		while (i < decoded.length && decoded.charCodeAt(i) < 0x20) i++;
		return decoded.slice(i);
	} catch {
		return null;
	}
}

function removePkcs7Padding(buf: Buffer): Buffer {
	if (!buf.length) return buf;
	const padding = buf[buf.length - 1];
	if (!padding || padding > 16) return buf;
	return buf.subarray(0, buf.length - padding);
}

function readBrowserPassword(
	config: BrowserConfig,
	currentPlatform: ReturnType<typeof platform>,
): Promise<string | null> {
	if (currentPlatform === "darwin") {
		if (!config.keychainAccount || !config.keychainService) return Promise.resolve(null);
		return readKeychainPassword(config.keychainAccount, config.keychainService);
	}
	if (currentPlatform === "linux") {
		return readLinuxPassword(config.secretToolApp);
	}
	return Promise.resolve(null);
}

function readKeychainPassword(account: string, service: string): Promise<string | null> {
	const cacheKey = `darwin:${account}:${service}`;
	const cached = browserPasswordCache.get(cacheKey);
	if (cached) return Promise.resolve(cached);

	return new Promise((resolve) => {
		execFile(
			"security",
			["find-generic-password", "-w", "-a", account, "-s", service],
			{ timeout: 5000 },
			(err, stdout) => {
				if (err) { resolve(null); return; }
				const password = stdout.trim() || null;
				if (password) browserPasswordCache.set(cacheKey, password);
				resolve(password);
			},
		);
	});
}

function readLinuxPassword(secretToolApp: string | undefined): Promise<string> {
	const cacheKey = `linux:${secretToolApp ?? "peanuts"}`;
	const cached = browserPasswordCache.get(cacheKey);
	if (cached) return Promise.resolve(cached);
	if (!secretToolApp) {
		browserPasswordCache.set(cacheKey, "peanuts");
		return Promise.resolve("peanuts");
	}

	return new Promise((resolve) => {
		execFile(
			"secret-tool",
			["lookup", "application", secretToolApp],
			{ timeout: 5000 },
			(err, stdout) => {
				if (err) {
					// KDE Wallet users fall through to peanuts intentionally.
					browserPasswordCache.set(cacheKey, "peanuts");
					resolve("peanuts");
					return;
				}
				const password = stdout.trim() || "peanuts";
				browserPasswordCache.set(cacheKey, password);
				resolve(password);
			},
		);
	});
}

let sqliteModule: typeof import("node:sqlite") | null = null;

async function importSqlite(): Promise<typeof import("node:sqlite") | null> {
	if (sqliteModule) return sqliteModule;
	const orig = process.emitWarning.bind(process);
	process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
		const msg = typeof warning === "string" ? warning : warning?.message ?? "";
		if (msg.includes("SQLite is an experimental feature")) return;
		return (orig as Function)(warning, ...args);
	}) as typeof process.emitWarning;
	try {
		sqliteModule = await import("node:sqlite");
		return sqliteModule;
	} catch {
		return null;
	} finally {
		process.emitWarning = orig;
	}
}

function supportsReadBigInts(): boolean {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major > 24) return true;
	if (major < 24) return false;
	return minor >= 4;
}

async function readMetaVersion(dbPath: string): Promise<number> {
	const sqlite = await importSqlite();
	if (!sqlite) return 0;
	const opts: Record<string, unknown> = { readOnly: true };
	if (supportsReadBigInts()) opts.readBigInts = true;
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		const rows = db.prepare("SELECT value FROM meta WHERE key = 'version'").all() as Array<Record<string, unknown>>;
		const val = rows[0]?.value;
		if (typeof val === "number") return Math.floor(val);
		if (typeof val === "bigint") return Number(val);
		if (typeof val === "string") return parseInt(val, 10) || 0;
		return 0;
	} catch {
		return 0;
	} finally {
		db.close();
	}
}

async function hasCookieNames(
	dbPath: string,
	hosts: string[],
	cookieNames: Iterable<string>,
): Promise<boolean> {
	const sqlite = await importSqlite();
	if (!sqlite) return false;
	const where = buildCookieWhere(hosts, cookieNames);
	const opts: Record<string, unknown> = { readOnly: true };
	if (supportsReadBigInts()) opts.readBigInts = true;
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		const rows = db
			.prepare(`SELECT DISTINCT name FROM cookies WHERE ${where}`)
			.all() as Array<Record<string, unknown>>;
		const present = new Set(
			rows
				.map((row) => (typeof row.name === "string" ? row.name : ""))
				.filter(Boolean),
		);
		for (const name of cookieNames) {
			if (!present.has(name)) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		db.close();
	}
}

async function queryCookieRows(
	dbPath: string,
	hosts: string[],
	cookieNames?: Iterable<string>,
): Promise<Array<Record<string, unknown>> | null> {
	const sqlite = await importSqlite();
	if (!sqlite) return null;
	const where = buildCookieWhere(hosts, cookieNames);

	const opts: Record<string, unknown> = { readOnly: true };
	if (supportsReadBigInts()) opts.readBigInts = true;
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		return db
			.prepare(
				`SELECT name, value, host_key, encrypted_value FROM cookies WHERE ${where} ORDER BY expires_utc DESC`,
			)
			.all() as Array<Record<string, unknown>>;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

function buildCookieWhere(hosts: string[], cookieNames?: Iterable<string>): string {
	const hostClauses: string[] = [];
	for (const host of hosts) {
		for (const candidate of expandHosts(host)) {
			const esc = escapeSqlString(candidate);
			hostClauses.push(`host_key = '${esc}'`);
			hostClauses.push(`host_key = '.${esc}'`);
			hostClauses.push(`host_key LIKE '%.${esc}'`);
		}
	}

	let where = `(${hostClauses.join(" OR ")})`;
	const normalizedNames = cookieNames ? [...cookieNames].filter(Boolean) : [];
	if (normalizedNames.length > 0) {
		const nameList = normalizedNames.map((name) => `'${escapeSqlString(name)}'`).join(", ");
		where += ` AND name IN (${nameList})`;
	}
	return where;
}

function escapeSqlString(value: string): string {
	return value.replaceAll("'", "''");
}

function expandHosts(host: string): string[] {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 1) return [host];
	const candidates = new Set<string>();
	candidates.add(host);
	for (let i = 1; i <= parts.length - 2; i++) {
		const c = parts.slice(i).join(".");
		if (c) candidates.add(c);
	}
	return Array.from(candidates);
}

function copySidecar(srcDb: string, targetDb: string, suffix: string): void {
	const sidecar = `${srcDb}${suffix}`;
	if (!existsSync(sidecar)) return;
	try {
		copyFileSync(sidecar, `${targetDb}${suffix}`);
	} catch {}
}
