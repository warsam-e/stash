import { type StashDriver, InMemoryDriver } from './drivers';
import type { Awaitable, StashDuration, StashOptions } from './types';

/**
 * Stash is a simple key-value store with expiration support.
 *
 * It allows you to store values with a specific duration and automatically
 * handles expiration and cache invalidation.
 *
 * The default driver is {@link InMemoryDriver}.
 */
export class Stash {
	#_base_key: string;
	#_driver: StashDriver;
	constructor(base_key: string, opts?: StashOptions) {
		this.#_base_key = base_key;
		this.#_driver = opts?.driver ?? new InMemoryDriver();
	}

	#_get<T>(key: string, duration: StashDuration) {
		return this.#_driver.get<T>(`${this.#_base_key}~${key}`, duration);
	}

	#_set<T>(key: string, duration: StashDuration, value: T) {
		return this.#_driver.set(`${this.#_base_key}~${key}`, duration, value);
	}

	#_delete(key: string) {
		return this.#_driver.delete(`${this.#_base_key}~${key}`);
	}

	/**
	 * Wrap the method you'd like to cache.
	 */
	async wrap<T>(key: string, duration: StashDuration, fn: () => Awaitable<T>): Promise<T> {
		const { data, in_grace_period } = await this.#_get<T>(key, duration);
		if (data) {
			if (in_grace_period) {
				(async () => fn())()
					.then((res) => this.#_set(key, duration, res))
					.catch((err) => console.error('[Grace Period Refresh Error]', err));
			}
			return data;
		}
		const res = await fn();
		return this.#_set(key, duration, res);
	}

	/**
	 * Get the cached value for the given key and duration.
	 */
	async get(key: string, duration: StashDuration) {
		const r = await this.#_get(key, duration);
		return r.data;
	}

	/**
	 * Set the cached value for the given key and duration.
	 */
	async set<T>(key: string, duration: StashDuration, value: T) {
		return this.#_set(key, duration, value);
	}

	/**
	 * Delete the cached value for the given key.
	 */
	async delete(key: string) {
		return this.#_delete(key);
	}
}

export * from './drivers';
export * from './types';

