import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultSleep, formatWait } from "./brave-rate-limit.ts";

// DuckDuckGo has no API quota, but it shows its bot check to the whole client IP
// (browsers included) when too many requests come from it, and keeps it up for 7 to
// 30 minutes. Tests from one home IP, each started when the IP was not blocked:
// - 2s apart: blocked after 3 to 34 searches. Right after a block clears, the third or
//   fourth quick search is blocked again.
// - 5s apart: blocked after 73 searches in 6 minutes, and on another day after 22
//   searches in 10 minutes (20 in the first 3 minutes).
// - 10s apart: blocked after 47 searches in 7 minutes.
// - 20s apart: 15 searches passed right after a block cleared.
// The block follows the number of requests from the IP, not how they look: a Chrome-
// impersonating POST (curl-impersonate) was blocked as fast as Node's fetch, and once
// the IP was blocked, every User-Agent, TLS fingerprint, method and endpoint (html and
// lite) got the bot check. DuckDuckGo also tolerates fewer searches after each block:
// after six blocks in one afternoon, 12 searches 5s apart were blocked again.
//
// So every search takes a start slot at least 10s after the previous one, with at most
// 10 starts in any 10 minutes. Three processes asking for 5 searches every minute or so
// ran 60 searches in 54 minutes at that pace, starting right after a block cleared, with
// no bot check. Each bot check doubles the gap and halves the budget (twice at most:
// 40s and 2 per 10 minutes), and one such step is undone every 4 hours without a bot
// check. The slots and the cooldown after a bot check live in a small state file shared
// by every Pi process, so subagents and parallel sessions share one budget instead of
// each sending its own burst. A search whose slot would come after its deadline fails
// at once (rate limited) so search routing moves on to another provider instead of
// waiting.

const DEFAULT_MIN_INTERVAL_MS = 10_000;
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_STARTS = 10;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 2 * 60 * 60_000;
const DEFAULT_MAX_STRIKES = 2;
const DEFAULT_STRIKE_DECAY_MS = 4 * 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Time left for the request itself after a slot; a later slot fails at once. */
const REQUEST_ALLOWANCE_MS = 10_000;

export class DuckDuckGoBotCheckError extends Error {
	constructor(status: number) {
		// "rate limited" makes search routing classify this as quota.
		super(`DuckDuckGo blocked the request with a bot check (HTTP ${status}, rate limited); use another search provider`);
		this.name = "DuckDuckGoBotCheckError";
	}
}

export interface DuckDuckGoGateState {
	/** Start time of the latest slot handed out, in ms since the epoch. */
	lastStart: number;
	/** Slot start times inside the budget window. */
	starts: number[];
	/** No searches until this time, after a bot check. */
	blockedUntil: number;
	/** Cooldown to apply after the next bot check. */
	nextCooldownMs: number;
	/** Recent bot checks, each halving the pace; one is forgiven per strike decay period. */
	strikes: number;
	lastBotCheck: number;
}

/** Holds the state; `update` must run `change` atomically with respect to other users. */
export interface DuckDuckGoGateStore {
	update<T>(change: (state: DuckDuckGoGateState) => T): T;
}

function initialState(cooldownMs: number): DuckDuckGoGateState {
	return { lastStart: Number.NEGATIVE_INFINITY, starts: [], blockedUntil: 0, nextCooldownMs: cooldownMs, strikes: 0, lastBotCheck: 0 };
}

/** State for this process only. */
export class MemoryDuckDuckGoGateStore implements DuckDuckGoGateStore {
	private state: DuckDuckGoGateState | null = null;
	private readonly cooldownMs: number;
	constructor(cooldownMs = DEFAULT_COOLDOWN_MS) {
		this.cooldownMs = cooldownMs;
	}
	update<T>(change: (state: DuckDuckGoGateState) => T): T {
		this.state ??= initialState(this.cooldownMs);
		return change(this.state);
	}
}

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 5;
const LOCK_MAX_WAIT_MS = 1_000;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * State in a JSON file shared by every process that uses the same path. A lock file made
 * with O_EXCL serializes the short read-change-write; a lock left by a crashed process is
 * taken over after a few seconds. If the lock or file cannot be used at all, the change
 * runs on this process's own copy so searches keep working.
 */
export class FileDuckDuckGoGateStore implements DuckDuckGoGateStore {
	private readonly path: string;
	private readonly cooldownMs: number;
	private readonly fallback: MemoryDuckDuckGoGateStore;
	constructor(path: string, cooldownMs = DEFAULT_COOLDOWN_MS) {
		this.path = path;
		this.cooldownMs = cooldownMs;
		this.fallback = new MemoryDuckDuckGoGateStore(cooldownMs);
	}

	update<T>(change: (state: DuckDuckGoGateState) => T): T {
		const lockPath = `${this.path}.lock`;
		let locked = false;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			locked = this.acquire(lockPath);
		} catch {
			// Unwritable directory: fall back below.
		}
		if (!locked) return this.fallback.update(change);
		try {
			const state = this.read();
			const result = change(state);
			const tmpPath = `${this.path}.${process.pid}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(state), { mode: 0o600 });
			renameSync(tmpPath, this.path);
			return result;
		} finally {
			try { unlinkSync(lockPath); } catch {}
		}
	}

	private acquire(lockPath: string): boolean {
		const started = Date.now();
		for (;;) {
			try {
				closeSync(openSync(lockPath, "wx", 0o600));
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				continue; // Released between the open and the stat.
			}
			if (Date.now() - started > LOCK_MAX_WAIT_MS) return false;
			sleepSync(LOCK_RETRY_MS);
		}
	}

	private read(): DuckDuckGoGateState {
		const state = initialState(this.cooldownMs);
		try {
			const saved = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DuckDuckGoGateState>;
			if (typeof saved.lastStart === "number") state.lastStart = saved.lastStart;
			if (Array.isArray(saved.starts)) state.starts = saved.starts.filter((value): value is number => typeof value === "number");
			if (typeof saved.blockedUntil === "number") state.blockedUntil = saved.blockedUntil;
			if (typeof saved.nextCooldownMs === "number" && saved.nextCooldownMs > 0) state.nextCooldownMs = saved.nextCooldownMs;
			if (typeof saved.strikes === "number" && saved.strikes >= 0) state.strikes = saved.strikes;
			if (typeof saved.lastBotCheck === "number") state.lastBotCheck = saved.lastBotCheck;
		} catch {
			// Missing or unreadable: start fresh.
		}
		return state;
	}
}

export interface DuckDuckGoRateLimitOptions {
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Shared state; defaults to state for this process only. */
	store?: DuckDuckGoGateStore;
	minIntervalMs?: number;
	/** At most `maxStarts` searches start in any `windowMs`. */
	windowMs?: number;
	maxStarts?: number;
	cooldownMs?: number;
	maxCooldownMs?: number;
	/** Each recent bot check doubles the gap and halves the budget, up to this many times. */
	maxStrikes?: number;
	/** How long it takes to forgive one bot check. */
	strikeDecayMs?: number;
	/** Deadline per search, counted from when it is called. */
	timeoutMs?: number;
}

function cooldownError(remainingMs: number): Error {
	return new Error(`DuckDuckGo showed a bot check recently; not retrying for ${formatWait(remainingMs)} so the block can clear (rate limited); use another search provider`);
}

export class DuckDuckGoRateLimit {
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly store: DuckDuckGoGateStore;
	private readonly minIntervalMs: number;
	private readonly windowMs: number;
	private readonly maxStarts: number;
	private readonly cooldownMs: number;
	private readonly maxCooldownMs: number;
	private readonly maxStrikes: number;
	private readonly strikeDecayMs: number;
	private readonly timeoutMs: number;

	constructor(options: DuckDuckGoRateLimitOptions = {}) {
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? defaultSleep;
		this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.maxStarts = Math.max(1, options.maxStarts ?? DEFAULT_MAX_STARTS);
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
		this.maxStrikes = options.maxStrikes ?? DEFAULT_MAX_STRIKES;
		this.strikeDecayMs = options.strikeDecayMs ?? DEFAULT_STRIKE_DECAY_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.store = options.store ?? new MemoryDuckDuckGoGateStore(this.cooldownMs);
	}

	/**
	 * Takes the next start slot, waits for it, and runs `operation` with a signal that
	 * fires on the caller's abort or when the deadline passes. A passed deadline rejects
	 * with a "timed out" error rather than an abort, so search routing treats it as a
	 * network failure and can fall back.
	 */
	async run<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
		if (callerSignal?.aborted) throw new Error("Aborted");
		const deadline = AbortSignal.timeout(this.timeoutMs);
		const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
		const latestStart = this.now() + Math.max(0, this.timeoutMs - REQUEST_ALLOWANCE_MS);
		try {
			const slot = this.reserve(latestStart);
			const waitMs = slot - this.now();
			if (waitMs > 0) await this.sleep(waitMs, signal);
			if (signal.aborted) throw new Error("Aborted");
			// Another process may have hit a bot check while this one waited.
			const blockedFor = this.store.update(state => state.blockedUntil - this.now());
			if (blockedFor > 0) throw cooldownError(blockedFor);
			return await this.attempt(operation, signal);
		} catch (error) {
			if (deadline.aborted && !callerSignal?.aborted) {
				throw new Error(`DuckDuckGo request timed out after ${formatWait(this.timeoutMs)}`);
			}
			throw error;
		}
	}

	private strikes(state: DuckDuckGoGateState, now: number): number {
		const forgiven = Math.floor((now - state.lastBotCheck) / this.strikeDecayMs);
		return Math.max(0, Math.min(state.strikes, this.maxStrikes) - Math.max(0, forgiven));
	}

	/** The gap and budget, slowed down by recent bot checks. */
	private pace(state: DuckDuckGoGateState, now: number): { intervalMs: number; maxStarts: number } {
		const factor = 2 ** this.strikes(state, now);
		return { intervalMs: this.minIntervalMs * factor, maxStarts: Math.max(1, Math.floor(this.maxStarts / factor)) };
	}

	private reserve(latestStart: number): number {
		type Outcome = { kind: "blocked"; ms: number } | { kind: "busy"; ms: number; intervalMs: number; maxStarts: number } | { kind: "slot"; at: number };
		const outcome = this.store.update((state): Outcome => {
			const now = this.now();
			if (state.blockedUntil > now) return { kind: "blocked", ms: state.blockedUntil - now };
			state.starts = state.starts.filter(start => start > now - this.windowMs).sort((a, b) => a - b);
			const { intervalMs, maxStarts } = this.pace(state, now);
			let slot = Math.max(now, state.lastStart + intervalMs);
			if (state.starts.length >= maxStarts) {
				slot = Math.max(slot, state.starts[state.starts.length - maxStarts] + this.windowMs);
			}
			if (slot > latestStart) return { kind: "busy", ms: slot - now, intervalMs, maxStarts };
			state.lastStart = slot;
			state.starts.push(slot);
			return { kind: "slot", at: slot };
		});
		if (outcome.kind === "blocked") throw cooldownError(outcome.ms);
		if (outcome.kind === "busy") {
			throw new Error(`DuckDuckGo is limited to one search every ${formatWait(outcome.intervalMs)} and ${outcome.maxStarts} every ${formatWait(this.windowMs)} on this machine to avoid its bot check; the next free slot is in ${formatWait(outcome.ms)} (rate limited); use another search provider`);
		}
		return outcome.at;
	}

	private async attempt<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		try {
			const result = await operation(signal);
			this.store.update(state => {
				if (state.blockedUntil <= this.now()) state.nextCooldownMs = this.cooldownMs;
			});
			return result;
		} catch (error) {
			if (error instanceof DuckDuckGoBotCheckError) {
				this.store.update(state => {
					const now = this.now();
					// Searches already in flight see the same block; count it once.
					if (state.blockedUntil > now) return;
					state.blockedUntil = now + state.nextCooldownMs;
					state.nextCooldownMs = Math.min(state.nextCooldownMs * 2, this.maxCooldownMs);
					state.strikes = Math.min(this.strikes(state, now) + 1, this.maxStrikes);
					state.lastBotCheck = now;
				});
			}
			throw error;
		}
	}
}
