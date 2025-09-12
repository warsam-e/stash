import { parseDate } from 'chrono-node';
import type { StashDuration } from '../types';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base';

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
		if (!existing) return { in_grace_period: false };

		if (existing.duration !== duration) {
			this.#_data.delete(key);
			return { in_grace_period: false };
		}

		const current_time = Date.now();
		const has_expired = current_time > existing.expires_at;
		const grace_expire_at = existing.expires_at + this.grace_period;
		const in_grace_period = has_expired && current_time < grace_expire_at;

		if (has_expired && !in_grace_period) {
			this.#_data.delete(key);
			return { in_grace_period: false };
		}

		return { data: JSON.parse(existing.response) as T, in_grace_period };
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const now = new Date();
		const expires_at_date = parseDate(duration, now);
		if (!expires_at_date) throw new Error('Invalid duration');
		const expires_at = expires_at_date.getTime();

		this.#_data.set(key, {
			response: JSON.stringify(value),
			duration,
			created_at: now.getTime(),
			expires_at,
		});
		return value;
	}

	async delete(key: string): Promise<void> {
		this.#_data.delete(key);
	}

	#_clean_handler = () => setInterval(this.#_clean.bind(this), 1000);

	#_clean() {
		const now = Date.now();
		for (const [key, data] of this.#_data) {
			const expired = data.expires_at < now;
			const in_grace = expired && now < data.expires_at + this.grace_period;
			if (!expired || in_grace) continue;
			this.#_data.delete(key);
		}
	}
}
