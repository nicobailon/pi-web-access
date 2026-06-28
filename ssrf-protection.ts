import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;
type Fetch = typeof fetch;

interface ValidationOptions {
	lookup?: Lookup;
	/**
	 * CIDR ranges (e.g. "198.18.0.0/15") to exempt from the SSRF guard.
	 * Useful when a host runs a TUN/fake-IP proxy (Surge, Clash, Mihomo, ...)
	 * that resolves public domains into a reserved range. Entries are validated
	 * strictly; an invalid entry throws so misconfiguration is not silent.
	 */
	allowRanges?: string[];
	/**
	 * When true, trust an explicitly-configured HTTP(S) proxy for hostname
	 * resolution instead of performing local DNS lookups inside the sandbox.
	 * This keeps localhost and literal IP blocking in place, but skips the
	 * preflight DNS resolution step for ordinary hostnames when they will be sent
	 * through a proxy. Intended for sandboxed environments where OpenShell and the
	 * outbound proxy already enforce egress policy.
	 */
	trustEnvProxy?: boolean;
}

/** Parsed entry from `allowRanges`: a network address (4 or 16 bytes) + prefix length. */
interface ParsedCidr {
	bytes: Uint8Array;
	prefix: number;
}

interface FetchRemoteOptions extends ValidationOptions {
	fetch?: Fetch;
	maxRedirects?: number;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
	return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function validateRemoteUrl(rawUrl: string | URL, options: ValidationOptions = {}): Promise<URL> {
	const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
	}

	const hostname = normalizeHostname(url.hostname);
	if (!hostname) throw new Error("URL must include a hostname");
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error(`Blocked internal hostname: ${hostname}`);
	}

	const allowRanges = parseAllowRanges(options.allowRanges);

	if (net.isIP(hostname)) {
		assertPublicAddress(hostname, hostname, allowRanges);
		return url;
	}

	if (shouldTrustEnvProxy(url, options.trustEnvProxy === true)) {
		return url;
	}

	let addresses: LookupAddress[];
	try {
		addresses = await (options.lookup ?? defaultLookup)(hostname);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to resolve ${hostname}: ${message}`);
	}

	if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
	for (const { address } of addresses) {
		assertPublicAddress(address, hostname, allowRanges);
	}
	return url;
}

export async function fetchRemoteUrl(
	url: string | URL,
	init: RequestInit = {},
	options: FetchRemoteOptions = {},
): Promise<Response> {
	const fetchImpl = options.fetch ?? fetch;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	let current = await validateRemoteUrl(url, options);
	let requestInit = init;

	for (let redirects = 0; redirects <= maxRedirects; redirects++) {
		const response = await fetchImpl(current, { ...requestInit, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;

		const location = response.headers.get("location");
		if (!location) return response;
		if (redirects === maxRedirects) throw new Error(`Too many redirects fetching ${current.toString()}`);

		current = await validateRemoteUrl(new URL(location, current), options);
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method?.toUpperCase() === "POST")) {
			const { body: _body, ...nextInit } = requestInit;
			requestInit = { ...nextInit, method: "GET" };
		}
	}

	throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function getProxyForProtocol(protocol: string): string {
	if (protocol === "http:") {
		return process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || "";
	}
	if (protocol === "https:") {
		return process.env.HTTPS_PROXY || process.env.https_proxy ||
			process.env.HTTP_PROXY || process.env.http_proxy ||
			process.env.ALL_PROXY || process.env.all_proxy || "";
	}
	return "";
}

function hostnameMatchesNoProxy(hostname: string, noProxyEntry: string): boolean {
	const entry = normalizeHostname(noProxyEntry.trim());
	if (!entry) return false;
	if (entry === "*") return true;
	if (entry === hostname) return true;
	const suffix = entry.startsWith("*.") ? entry.slice(1) : entry.startsWith(".") ? entry : `.${entry}`;
	return hostname.endsWith(suffix);
}

function shouldTrustEnvProxy(url: URL, enabled: boolean): boolean {
	if (!enabled) return false;
	if (!getProxyForProtocol(url.protocol)) return false;
	const hostname = normalizeHostname(url.hostname);
	const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
	if (!noProxy) return true;
	return !noProxy.split(",").some(entry => hostnameMatchesNoProxy(hostname, entry));
}

function assertPublicAddress(address: string, hostname: string, allowRanges: ParsedCidr[] = []): void {
	const normalized = normalizeHostname(address);
	const ipVersion = net.isIP(normalized);
	if (ipVersion === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
	// Explicitly-allowed ranges bypass the private/reserved checks below. This lets
	// users exempt synthetic ranges produced by TUN/fake-IP proxies (e.g. 198.18/15).
	if (isInAllowedRange(normalized, ipVersion, allowRanges)) return;
	if (ipVersion === 4 && isBlockedIPv4(normalized)) {
		throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
	}
	if (ipVersion === 6 && isBlockedIPv6(normalized)) {
		throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
	}
}

function isBlockedIPv4(address: string): boolean {
	const parts = address.split(".").map(part => Number(part));
	if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224;
}

function isBlockedIPv6(address: string): boolean {
	const groups = parseIPv6(address);
	if (!groups) return true;

	const first = groups[0];
	if (groups.every(group => group === 0)) return true;
	if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true;
	if ((first & 0xfe00) === 0xfc00) return true;
	if ((first & 0xffc0) === 0xfe80) return true;

	const isMappedIPv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
	if (isMappedIPv4) {
		const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
		return isBlockedIPv4(ipv4);
	}

	return false;
}

function parseIPv6(address: string): number[] | null {
	if (address.includes(".")) {
		const lastColon = address.lastIndexOf(":");
		const ipv4 = address.slice(lastColon + 1);
		if (net.isIP(ipv4) !== 4) return null;
		const octets = ipv4.split(".").map(part => Number(part));
		address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}

	const pieces = address.split("::");
	if (pieces.length > 2) return null;

	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if (pieces.length === 1 && missing !== 0) return null;
	if (pieces.length === 2 && missing < 0) return null;

	const groups = [...left, ...Array(missing).fill("0"), ...right].map(part => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return parseInt(part, 16);
	});
	return groups.length === 8 && groups.every(group => group >= 0 && group <= 0xffff) ? groups : null;
}

/** Parse `allowRanges` config value into validated CIDR rules. Throws on malformed entries. */
function parseAllowRanges(input: unknown): ParsedCidr[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) {
		throw new Error("ssrf.allowRanges must be an array of CIDR strings");
	}
	const rules: ParsedCidr[] = [];
	for (const entry of input) {
		if (typeof entry !== "string") {
			throw new Error(`ssrf.allowRanges entries must be strings, got ${typeof entry}`);
		}
		const rule = parseCidr(entry.trim());
		if (!rule) {
			throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
		}
		rules.push(rule);
	}
	return rules;
}

/** Parse a single CIDR (e.g. "198.18.0.0/15", "fd00::/8") or bare host ("1.2.3.4"). Returns null if invalid. */
function parseCidr(raw: string): ParsedCidr | null {
	if (!raw) return null;
	const slash = raw.lastIndexOf("/");
	const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
	const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
	// A slash must be followed by digits. Number("")/Number(" ") are 0, which
	// would silently turn "198.18.0.0/" into /0 and exempt every address.
	if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;
	const version = net.isIP(addrPart);

	if (version === 4) {
		const bytes = ipv4ToBytes(addrPart);
		if (!bytes) return null;
		const prefix = prefixPart === null ? 32 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
		return { bytes, prefix };
	}
	if (version === 6) {
		const groups = parseIPv6(addrPart);
		if (!groups) return null;
		const prefix = prefixPart === null ? 128 : Number(prefixPart);
		if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
		return { bytes: ipv6GroupsToBytes(groups), prefix };
	}
	return null;
}

function ipv4ToBytes(address: string): Uint8Array | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const octet = Number(parts[i]);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
		bytes[i] = octet;
	}
	return bytes;
}

function ipv6GroupsToBytes(groups: number[]): Uint8Array {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		bytes[i * 2] = groups[i] >> 8;
		bytes[i * 2 + 1] = groups[i] & 0xff;
	}
	return bytes;
}

function ipToBytes(address: string, version: number): Uint8Array | null {
	if (version === 4) return ipv4ToBytes(address);
	if (version === 6) {
		const groups = parseIPv6(address);
		return groups ? ipv6GroupsToBytes(groups) : null;
	}
	return null;
}

/** True if `address` (already validated as `ipVersion`) falls within any allowed CIDR. */
function isInAllowedRange(address: string, ipVersion: number, allowRanges: ParsedCidr[]): boolean {
	if (allowRanges.length === 0) return false;
	const addrBytes = ipToBytes(address, ipVersion);
	if (!addrBytes) return false;
	for (const rule of allowRanges) {
		// Only compare same-family rules (4-byte IPv4 vs 16-byte IPv6).
		if (rule.bytes.length !== addrBytes.length) continue;
		if (bytesMatchPrefix(addrBytes, rule.bytes, rule.prefix)) return true;
	}
	return false;
}

/** Compare the leading `prefix` bits of two equal-length byte arrays. */
function bytesMatchPrefix(addr: Uint8Array, network: Uint8Array, prefix: number): boolean {
	const fullBytes = prefix >> 3;
	const remBits = prefix & 7;
	for (let i = 0; i < fullBytes; i++) {
		if (addr[i] !== network[i]) return false;
	}
	if (remBits > 0 && fullBytes < addr.length) {
		const mask = (0xff << (8 - remBits)) & 0xff;
		if ((addr[fullBytes] & mask) !== (network[fullBytes] & mask)) return false;
	}
	return true;
}
