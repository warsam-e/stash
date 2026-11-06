import type { StashDuration } from '../types.ts';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base.ts';
import { assertUnambiguousKeys, expiration, namespacePrefix } from './utils.ts';

interface _InMemoryDriverData {
	response: string;
	duration: StashDuration;
	created_at: number;
	expires_at: number;
}

/**
 * In-memory stash driver implementation.
 *
 * This driver stores data in memory and is suitable for testing and lightweight use cases.
 */
export class InMemoryDriver extends StashDriver {
	#_data = new Map<string, _InMemoryDriverData>();

	constructor(opts?: StashDriverOptions) {
		super(opts);
		this.#_clean_handler();
	}

	async get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>> {
		const existing = this.#_data.get(key);
		if (!existing) return { data: null, in_grace_period: false, found: false };

		if (existing.duration !== duration) {
			return { data: null, in_grace_period: false, found: false };
		}

		const current_time = Date.now();
		const has_expired = current_time >= existing.expires_at;
		const grace_expire_at = existing.expires_at + this.grace_period * 1000;
		const in_grace_period = has_expired && current_time < grace_expire_at;

		if (has_expired && !in_grace_period) {
			this.#_data.delete(key);
			return { data: null, in_grace_period: false, found: false };
		}

		return { data: JSON.parse(existing.response) as T, in_grace_period, found: true };
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const now = Date.now();
		const expires_at = expiration(duration, now);

		this.#_data.set(key, {
			response: JSON.stringify(value),
			duration,
			created_at: now,
			expires_at,
		});
		return value;
	}

	async delete(key: string): Promise<void> {
		this.#_data.delete(key);
	}

	async clear(): Promise<void> {
		this.#_data.clear();
	}

	async clearNamespace(namespace: string): Promise<void> {
		const prefix = namespacePrefix(namespace);
		const keys = [...this.#_data.keys()].filter((key) => key.startsWith(prefix));
		assertUnambiguousKeys(keys, prefix);
		for (const key of keys) this.#_data.delete(key);
	}

	#_clean_handler = () => setInterval(this.#_clean.bind(this), 1000).unref();

	#_clean() {
		const now = Date.now();
		for (const [key, data] of this.#_data) {
			const expired = data.expires_at <= now;
			const in_grace = expired && now < data.expires_at + this.grace_period * 1000;
			if (!expired || in_grace) continue;
			this.#_data.delete(key);
		}
	}
}
