import { BunDB } from 'bun.db';
import { parseDate } from 'chrono-node';
import type { StashDuration } from '../types';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base';

interface _SQliteDriverData<T> {
	response: T;
	duration: StashDuration;
	created_at: number;
	expires_at: number;
}

export class SQliteDriver extends StashDriver {
	#_client: BunDB;

	private constructor(client: BunDB, opts?: StashDriverOptions) {
		super(opts);
		this.#_client = client;
		this.#_clean_handler();
	}

	static create(path: string, opts?: StashDriverOptions) {
		const client = new BunDB(path);
		return new SQliteDriver(client, opts);
	}

	async get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>> {
		const existing = await this.#_client.get<_SQliteDriverData<T>>(key);
		if (!existing) return { data: null, in_grace_period: false };

		if (existing.duration !== duration) {
			await this.#_client.delete(key);
			return { data: null, in_grace_period: false };
		}

		const current_time = Date.now();
		const has_expired = current_time > existing.expires_at;
		const grace_expire_at = existing.expires_at + this.grace_period;
		const in_grace_period = has_expired && current_time < grace_expire_at;

		if (has_expired && !in_grace_period) {
			await this.#_client.delete(key);
			return { data: null, in_grace_period: false };
		}

		return { data: existing.response, in_grace_period };
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const now = new Date();
		const expires_at_date = parseDate(duration, now);
		if (!expires_at_date) throw new Error('Invalid duration');
		const expires_at = expires_at_date.getTime();

		await this.#_client.set(key, {
			response: value,
			duration,
			created_at: now.getTime(),
			expires_at,
		});
		return value;
	}

	async delete(key: string): Promise<void> {
		await this.#_client.delete(key);
	}

	async clear(): Promise<void> {
		await this.#_client.deleteAll();
	}

	#_clean_handler = () => setInterval(this.#_clean.bind(this), 1000);

	async #_clean() {
		const now = Date.now();
		const items = await this.#_client.all<_SQliteDriverData<unknown>>();
		for (const item of items) {
			const expired = item.value.expires_at < now;
			const in_grace = expired && now < item.value.expires_at + this.grace_period;
			if (!expired || in_grace) continue;
			await this.#_client.delete(item.id);
		}
	}
}
