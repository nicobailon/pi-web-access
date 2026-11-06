import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { awaitWithAbort } from "./abortable.ts";
import { defaultSleep, formatWait } from "./brave-rate-limit.ts";

// DuckDuckGo has no API quota, but it shows its bot check to the whole client IP
// (browsers included) once too many requests come from it, and keeps it up for 7 to 30
// minutes. Changing the User-Agent, TLS fingerprint or endpoint does not help. Tests from
// one home IP: 2s apart was blocked after 3 to 34 searches, 5s apart after 22 searches in
// 10 minutes, 10s apart back to back after 47 searches; 10s apart with at most 10 per 10
// minutes ran 60 searches in 54 minutes from three processes with no bot check. A retry
// soon after a block brings it back, hence the long, doubling pause.

const DEFAULT_MIN_INTERVAL_MS = 10_000;
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_STARTS = 10;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 2 * 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Part of the deadline kept for the request itself; a search that would start later fails at once. */
const REQUEST_ALLOWANCE_MS = 10_000;

export class DuckDuckGoBotCheckError extends Error {
	constructor(status: number) {
		// "rate limited" makes search routing classify this as quota.
		super(`DuckDuckGo blocked the request with a bot check (HTTP ${status}, rate limited); use another search provider`);
		this.name = "DuckDuckGoBotCheckError";
	}
}

export interface DuckDuckGoRateLimitOptions {
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	minIntervalMs?: number;
	/** At most `maxStarts` searches start in any `windowMs`. */
	windowMs?: number;
	maxStarts?: number;
	cooldownMs?: number;
	maxCooldownMs?: number;
	/** Deadline per search, counted from when it is called. */
	timeoutMs?: number;
	/** File that shares the bot-check pause with other processes; unset keeps it in this process. */
	statePath?: string;
}

interface Cooldown {
	blockedUntil: number;
	/** Pause to apply after the next bot check. */
	nextCooldownMs: number;
}

function cooldownError(remainingMs: number): Error {
	return new Error(`DuckDuckGo showed a bot check recently; not retrying for ${formatWait(remainingMs)} so the block can clear (rate limited); use another search provider`);
}

export class DuckDuckGoRateLimit {
	private queue: Promise<void> = Promise.resolve();
	/** Searches queued that have not started yet. */
	private waiting = 0;
	/** Actual start times of the latest `maxStarts` searches, oldest first. */
	private starts: number[] = [];
	private cooldown: Cooldown;
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly minIntervalMs: number;
	private readonly windowMs: number;
	private readonly maxStarts: number;
	private readonly cooldownMs: number;
	private readonly maxCooldownMs: number;
	private readonly timeoutMs: number;
	private readonly statePath: string | undefined;

	constructor(options: DuckDuckGoRateLimitOptions = {}) {
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? defaultSleep;
		this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.maxStarts = Math.max(1, options.maxStarts ?? DEFAULT_MAX_STARTS);
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.statePath = options.statePath;
		this.cooldown = { blockedUntil: 0, nextCooldownMs: this.cooldownMs };
	}

	/**
	 * Queues `operation` behind earlier searches and runs it with a signal that fires on the
	 * caller's abort or when the deadline passes. A search that cannot start before its
	 * deadline fails at once as rate limited, so routing moves on without waiting. A passed
	 * deadline rejects with a "timed out" error rather than an abort, so search routing
	 * treats it as a network failure and can fall back.
	 */
	async run<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
		if (callerSignal?.aborted) throw new Error("Aborted");
		const now = this.now();
		const latestStart = now + Math.max(0, this.timeoutMs - REQUEST_ALLOWANCE_MS);
		this.throwIfBlocked(now);
		const slot = this.nextSlot(now, this.waiting + 1);
		if (slot > latestStart) throw this.busyError(slot - now);

		const deadline = AbortSignal.timeout(this.timeoutMs);
		const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
		this.waiting++;
		const started = this.queue.then(() => this.waitForSlot(signal, latestStart)).finally(() => { this.waiting--; });
		this.queue = started.then(() => undefined, () => undefined);
		try {
			// Let a search give up while still queued without unblocking the queue early.
			return await awaitWithAbort(started.then(() => this.attempt(operation, signal)), signal);
		} catch (error) {
			if (deadline.aborted && !callerSignal?.aborted) {
				throw new Error(`DuckDuckGo request timed out after ${formatWait(this.timeoutMs)}`);
			}
			throw error;
		}
	}

	/** Start time of the `count`th search from now, given the searches already started. */
	private nextSlot(now: number, count: number): number {
		const starts = [...this.starts];
		let slot = now;
		for (let i = 0; i < count; i++) {
			slot = Math.max(now, (starts.at(-1) ?? Number.NEGATIVE_INFINITY) + this.minIntervalMs);
			if (starts.length >= this.maxStarts) slot = Math.max(slot, starts[starts.length - this.maxStarts] + this.windowMs);
			starts.push(slot);
		}
		return slot;
	}

	/** Runs at the head of the queue, so spacing is measured from the previous search's actual start. */
	private async waitForSlot(signal: AbortSignal, latestStart: number): Promise<void> {
		for (;;) {
			if (signal.aborted) throw new Error("Aborted");
			const now = this.now();
			this.throwIfBlocked(now);
			const slot = this.nextSlot(now, 1);
			if (slot <= now) {
				this.starts.push(now);
				if (this.starts.length > this.maxStarts) this.starts.shift();
				return;
			}
			if (slot > latestStart) throw this.busyError(slot - now);
			await this.sleep(slot - now, signal);
		}
	}

	private busyError(waitMs: number): Error {
		return new Error(`DuckDuckGo is limited to one search every ${formatWait(this.minIntervalMs)} and ${this.maxStarts} every ${formatWait(this.windowMs)} in this process to avoid its bot check; the next free slot is in ${formatWait(waitMs)} (rate limited); use another search provider`);
	}

	private throwIfBlocked(now: number): void {
		this.loadSharedCooldown();
		const remainingMs = this.cooldown.blockedUntil - now;
		if (remainingMs > 0) throw cooldownError(remainingMs);
	}

	private async attempt<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		try {
			const result = await operation(signal);
			this.loadSharedCooldown();
			if (this.cooldown.nextCooldownMs !== this.cooldownMs && this.cooldown.blockedUntil <= this.now()) {
				this.cooldown = { ...this.cooldown, nextCooldownMs: this.cooldownMs };
				this.saveSharedCooldown();
			}
			return result;
		} catch (error) {
			if (error instanceof DuckDuckGoBotCheckError) {
				this.loadSharedCooldown();
				const now = this.now();
				// Searches already in flight see the same block; count it once.
				if (this.cooldown.blockedUntil <= now) {
					const pauseMs = this.cooldown.nextCooldownMs;
					this.cooldown = { blockedUntil: now + pauseMs, nextCooldownMs: Math.min(pauseMs * 2, this.maxCooldownMs) };
					this.saveSharedCooldown();
				}
			}
			throw error;
		}
	}

	// The state file is best effort: if it cannot be read or written, this process keeps
	// its own pause, and a search never fails or loses its result because of the file.
	private loadSharedCooldown(): void {
		if (!this.statePath) return;
		try {
			const saved = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<Cooldown>;
			const { blockedUntil, nextCooldownMs } = saved;
			if (typeof blockedUntil !== "number" || typeof nextCooldownMs !== "number" || !(nextCooldownMs > 0)) return;
			if (blockedUntil >= this.cooldown.blockedUntil) this.cooldown = { blockedUntil, nextCooldownMs };
		} catch {}
	}

	private saveSharedCooldown(): void {
		if (!this.statePath) return;
		try {
			mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
			const tmpPath = `${this.statePath}.${process.pid}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(this.cooldown), { mode: 0o600 });
			renameSync(tmpPath, this.statePath);
		} catch {}
	}
}
