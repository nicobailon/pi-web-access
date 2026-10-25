// DuckDuckGo has no API quota, but it shows its bot check to the whole client IP
// (browsers included) when requests arrive in bursts, and keeps it up for 10-15
// minutes, longer after repeated blocks. Requests spaced about 2s apart pass. So
// searches run one at a time with a minimum gap, and after a bot check this process
// stops asking for a while instead of retrying, since retries only keep the block in
// place. Each search's deadline covers its time in the queue as well as the request.

const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

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
	cooldownMs?: number;
	maxCooldownMs?: number;
	/** Deadline per search, counted from when it is queued. */
	timeoutMs?: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function formatWait(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}

export class DuckDuckGoRateLimit {
	private queue: Promise<void> = Promise.resolve();
	private lastStart = Number.NEGATIVE_INFINITY;
	private blockedUntil = 0;
	private nextCooldownMs: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly minIntervalMs: number;
	private readonly cooldownMs: number;
	private readonly maxCooldownMs: number;
	private readonly timeoutMs: number;

	constructor(options: DuckDuckGoRateLimitOptions = {}) {
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? defaultSleep;
		this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.maxCooldownMs = Math.max(this.cooldownMs, options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS);
		this.nextCooldownMs = this.cooldownMs;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * Queues `operation` and passes it a signal that fires on the caller's abort or when
	 * the deadline passes. A passed deadline rejects with a "timed out" error rather than
	 * an abort, so search routing treats it as a network failure and can fall back.
	 */
	run<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
		if (callerSignal?.aborted) return Promise.reject(new Error("Aborted"));
		const deadline = AbortSignal.timeout(this.timeoutMs);
		const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
		const scheduled = this.queue.then(() => this.runNow(operation, signal));
		this.queue = scheduled.then(() => undefined, () => undefined);
		// Let a search give up while still queued without unblocking the queue early.
		const settled = new Promise<T>((resolve, reject) => {
			const onAbort = () => reject(new Error("Aborted"));
			signal.addEventListener("abort", onAbort, { once: true });
			scheduled.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
		return settled.catch(error => {
			if (deadline.aborted && !callerSignal?.aborted) {
				throw new Error(`DuckDuckGo request timed out after ${formatWait(this.timeoutMs)}`);
			}
			throw error;
		});
	}

	private async runNow<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		if (signal?.aborted) throw new Error("Aborted");
		this.assertNotCoolingDown();
		const waitMs = this.lastStart + this.minIntervalMs - this.now();
		if (waitMs > 0) await this.sleep(waitMs, signal);
		this.lastStart = this.now();
		try {
			const result = await operation(signal);
			this.nextCooldownMs = this.cooldownMs;
			return result;
		} catch (error) {
			if (error instanceof DuckDuckGoBotCheckError) this.startCooldown();
			throw error;
		}
	}

	private assertNotCoolingDown(): void {
		const remainingMs = this.blockedUntil - this.now();
		if (remainingMs <= 0) return;
		throw new Error(`DuckDuckGo showed a bot check recently; not retrying for ${formatWait(remainingMs)} so the block can clear (rate limited); use another search provider`);
	}

	private startCooldown(): void {
		if (this.cooldownMs <= 0) return;
		this.blockedUntil = this.now() + this.nextCooldownMs;
		this.nextCooldownMs = Math.min(this.nextCooldownMs * 2, this.maxCooldownMs);
	}
}
