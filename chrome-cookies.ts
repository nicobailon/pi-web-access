import { execFile } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";

export type CookieMap = Record<string, string>;

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

const CHROME_COOKIES_PATH = join(
	homedir(),
	"Library/Application Support/Google/Chrome/Default/Cookies",
);

export async function getGoogleCookies(): Promise<{ cookies: CookieMap; warnings: string[] } | null> {
	if (platform() !== "darwin") return null;
	if (!existsSync(CHROME_COOKIES_PATH)) return null;

	const warnings: string[] = [];

	const password = await readKeychainPassword();
	if (!password) {
		warnings.push("Could not read Chrome Safe Storage password from Keychain");
		return { cookies: {}, warnings };
	}

	const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
	const tempDir = mkdtempSync(join(tmpdir(), "pi-chrome-cookies-"));

	try {
		const tempDb = join(tempDir, "Cookies");
		copyFileSync(CHROME_COOKIES_PATH, tempDb);
		copySidecar(CHROME_COOKIES_PATH, tempDb, "-wal");
		copySidecar(CHROME_COOKIES_PATH, tempDb, "-shm");

		const metaVersion = await readMetaVersion(tempDb);
		const stripHash = metaVersion >= 24;

		const hosts = GOOGLE_ORIGINS.map((o) => new URL(o).hostname);
		const rows = await queryCookieRows(tempDb, hosts);
		if (!rows) {
			warnings.push("Failed to query Chrome cookie database");
			return { cookies: {}, warnings };
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

		return { cookies, warnings };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
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

function readKeychainPassword(): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"security",
			["find-generic-password", "-w", "-a", "Chrome", "-s", "Chrome Safe Storage"],
			{ timeout: 5000 },
			(err, stdout) => {
				if (err) { resolve(null); return; }
				resolve(stdout.trim() || null);
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

async function queryCookieRows(
	dbPath: string,
	hosts: string[],
): Promise<Array<Record<string, unknown>> | null> {
	const sqlite = await importSqlite();
	if (!sqlite) return null;

	const clauses: string[] = [];
	for (const host of hosts) {
		for (const candidate of expandHosts(host)) {
			const esc = candidate.replaceAll("'", "''");
			clauses.push(`host_key = '${esc}'`);
			clauses.push(`host_key = '.${esc}'`);
			clauses.push(`host_key LIKE '%.${esc}'`);
		}
	}
	const where = clauses.join(" OR ");

	const opts: Record<string, unknown> = { readOnly: true };
	if (supportsReadBigInts()) opts.readBigInts = true;
	const db = new sqlite.DatabaseSync(dbPath, opts);
	try {
		return db
			.prepare(
				`SELECT name, value, host_key, encrypted_value FROM cookies WHERE (${where}) ORDER BY expires_utc DESC`,
			)
			.all() as Array<Record<string, unknown>>;
	} catch {
		return null;
	} finally {
		db.close();
	}
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
