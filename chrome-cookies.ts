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

interface PlatformConfig {
	cookiePath: string;
	getPassword: () => Promise<string | null>;
	pbkdf2Iterations: number;
}

function getDarwinConfig(): PlatformConfig {
	return {
		cookiePath: join(homedir(), "Library/Application Support/Google/Chrome/Default/Cookies"),
		getPassword: readMacKeychainPassword,
		pbkdf2Iterations: 1003,
	};
}

function getLinuxConfig(): PlatformConfig {
	return {
		cookiePath: join(homedir(), ".config/google-chrome/Default/Cookies"),
		getPassword: readLinuxKeychainPassword,
		pbkdf2Iterations: 1,
	};
}

function getPlatformConfig(): PlatformConfig | null {
	const os = platform();
	if (os === "darwin") return getDarwinConfig();
	if (os === "linux") return getLinuxConfig();
	return null;
}

export async function getGoogleCookies(): Promise<{ cookies: CookieMap; warnings: string[] } | null> {
	const config = getPlatformConfig();
	if (!config) return null;
	if (!existsSync(config.cookiePath)) return null;

	const warnings: string[] = [];

	const password = await config.getPassword();
	if (!password) {
		warnings.push("Could not read Chrome Safe Storage password");
		return { cookies: {}, warnings };
	}

	const key = pbkdf2Sync(password, "saltysalt", config.pbkdf2Iterations, 16, "sha1");
	const tempDir = mkdtempSync(join(tmpdir(), "pi-chrome-cookies-"));

	try {
		const tempDb = join(tempDir, "Cookies");
		copyFileSync(config.cookiePath, tempDb);
		copySidecar(config.cookiePath, tempDb, "-wal");
		copySidecar(config.cookiePath, tempDb, "-shm");

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

// macOS: read password from Keychain via `security` CLI
function readMacKeychainPassword(): Promise<string | null> {
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

// Linux: read password from GNOME Keyring (libsecret) via `secret-tool`,
// then try KWallet via `kwallet-query`, fallback to "peanuts"
async function readLinuxKeychainPassword(): Promise<string> {
	// Try GNOME Keyring / libsecret via secret-tool
	const secretToolPassword = await runCommand(
		"secret-tool",
		["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v2", "application", "chrome"],
	);
	if (secretToolPassword) return secretToolPassword;

	// Try older v1 schema
	const secretToolV1 = await runCommand(
		"secret-tool",
		["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v1", "application", "chrome"],
	);
	if (secretToolV1) return secretToolV1;

	// Try KWallet via kwallet-query (KDE)
	const kwalletPassword = await readKWalletPassword();
	if (kwalletPassword) return kwalletPassword;

	// Chromium fallback when no keyring is available
	return "peanuts";
}

function readKWalletPassword(): Promise<string | null> {
	return new Promise((resolve) => {
		// First check if KWallet is available
		execFile("dbus-send", [
			"--session",
			"--dest=org.kde.kwalletd6",
			"--print-reply",
			"/modules/kwalletd6",
			"org.kde.KWallet.isEnabled",
		], { timeout: 3000 }, (err, stdout) => {
			if (err) {
				// Try kwalletd5
				execFile("dbus-send", [
					"--session",
					"--dest=org.kde.kwalletd5",
					"--print-reply",
					"/modules/kwalletd5",
					"org.kde.KWallet.isEnabled",
				], { timeout: 3000 }, (err2) => {
					if (err2) { resolve(null); return; }
					readFromKWallet("kwalletd5", resolve);
				});
				return;
			}
			readFromKWallet("kwalletd6", resolve);
		});
	});
}

function readFromKWallet(daemon: string, resolve: (value: string | null) => void): void {
	// kwallet-query reads a password entry from KWallet
	execFile("kwallet-query", [
		"-r", "Chrome Safe Storage",
		"-f", "Chrome Keys",
		"kdewallet",
	], { timeout: 5000 }, (err, stdout) => {
		if (err) { resolve(null); return; }
		const pw = stdout.trim();
		resolve(pw || null);
	});
}

function runCommand(cmd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
			if (err) { resolve(null); return; }
			resolve(stdout.trim() || null);
		});
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
