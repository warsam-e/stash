import { InMemoryDriver, type StashDriver } from './drivers/index.ts';
import type { Awaitable, StashDuration, StashOptions } from './types.ts';

interface Pending {
	duration: StashDuration;
	valid: boolean;
	promise: Promise<unknown>;
	refresh?: Promise<unknown>;
}
interface NamespaceState {
	pending: Map<string, Pending>;
	tail: Promise<unknown>;
}
// Coordination is shared by Stash objects using the same driver object and namespace.
const states = new WeakMap<StashDriver, Map<string, NamespaceState>>();

/** A key-value cache with expiration and background refresh during the grace period. */
export class Stash {
	#_base_key: string;
	#_driver: StashDriver;
	#state: NamespaceState;

	constructor(base_key: string, opts?: StashOptions) {
		this.#_base_key = base_key;
		this.#_driver = opts?.driver ?? new InMemoryDriver();
		let namespaces = states.get(this.#_driver);
		if (!namespaces) states.set(this.#_driver, (namespaces = new Map()));
		let state = namespaces.get(base_key);
		if (!state) namespaces.set(base_key, (state = { pending: new Map(), tail: Promise.resolve() }));
		this.#state = state;
	}

	#key(key: string) {
		return `${this.#_base_key}~${key}`;
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#state.tail.then(operation);
		this.#state.tail = result.catch(() => {});
		return result;
	}

	#invalidate(key: string) {
		const pending = this.#state.pending.get(key);
		if (pending) pending.valid = false;
		this.#state.pending.delete(key);
	}

	/** Cache a computation, sharing pending work for the same key and duration. */
	async wrap<T>(key: string, duration: StashDuration, fn: () => Awaitable<T>): Promise<T> {
		const existing = this.#state.pending.get(key);
		if (existing?.duration === duration) {
			if (!existing.refresh) return existing.promise as Promise<T>;
			await this.#state.tail;
			const response = await this.#_driver.get<T>(this.#key(key), duration);
			if (response.found ?? response.data !== null) return response.data as T;
			// Once grace ends, wait for the refresh instead of serving stale data indefinitely.
			return existing.refresh as Promise<T>;
		}
		this.#invalidate(key);
		const task: Pending = { duration, valid: true, promise: Promise.resolve() };
		const finish = () => {
			if (this.#state.pending.get(key) === task) this.#state.pending.delete(key);
		};
		const compute = async () => {
			const value = await fn();
			await this.#enqueue(async () => {
				if (task.valid) await this.#_driver.set(this.#key(key), duration, value);
			});
			return value;
		};
		task.promise = Promise.resolve().then(async () => {
			let refreshing = false;
			try {
				await this.#state.tail;
				const response = await this.#_driver.get<T>(this.#key(key), duration);
				// Legacy drivers can omit found; explicit found supports cached null values.
				if (response.found ?? response.data !== null) {
					if (response.in_grace_period && task.valid) {
						refreshing = true;
						task.refresh = compute();
						void task.refresh
							.catch((error) => console.error('[Grace Period Refresh Error]', error))
							.finally(finish);
					}
					return response.data as T;
				}
				return await compute();
			} finally {
				if (!refreshing) finish();
			}
		});
		this.#state.pending.set(key, task);
		return task.promise as Promise<T>;
	}

	/** Get a cached value, or null for a miss. */
	async get<T>(key: string, duration: StashDuration) {
		await this.#state.tail;
		return (await this.#_driver.get<T>(this.#key(key), duration)).data;
	}

	/** Set a cached value and supersede any pending computation for this key. */
	async set<T>(key: string, duration: StashDuration, value: T) {
		this.#invalidate(key);
		return this.#enqueue(() => this.#_driver.set(this.#key(key), duration, value));
	}

	/** Delete a cached value and invalidate its pending computation. */
	async delete(key: string) {
		this.#invalidate(key);
		return this.#enqueue(() => this.#_driver.delete(this.#key(key)));
	}

	/** Clear this namespace only, leaving other namespaces untouched. */
	async clear() {
		for (const task of this.#state.pending.values()) task.valid = false;
		this.#state.pending.clear();
		return this.#enqueue(() => {
			if (!this.#_driver.clearNamespace)
				throw new Error('This driver does not support namespace-scoped clearing');
			return this.#_driver.clearNamespace(this.#_base_key);
		});
	}
}

export * from './drivers/index.ts';
export * from './types.ts';
