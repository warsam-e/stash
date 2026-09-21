import { parseDate } from 'chrono-node';
import { createClient } from 'redis';
import type { StashDuration } from '../types.ts';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base.ts';

const _create_client = (url: string) => createClient({ url }).connect();
type Client = Awaited<ReturnType<typeof _create_client>>;

/**
 * Redis stash driver implementation.
 *
 * This driver stores data in a Redis database and is suitable for production use cases.
 */
export class RedisDriver extends StashDriver {
	client: Client;

	private constructor(client: Client, opts?: StashDriverOptions) {
		super(opts);
		this.client = client;
	}

	static async create(url: string, opts?: StashDriverOptions) {
		const client = await _create_client(url);
		return new RedisDriver(client, opts);
	}

	async get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>> {
		const [response, _duration] = await this.client.hmGet(key, ['response', 'duration']);
		if (!response || !_duration) return { data: null, in_grace_period: false };

		if (_duration !== duration) {
			console.log('[Duration mismatch]', key, _duration, duration);
			await this.client.hDel(key, 'response');
			await this.client.hDel(key, 'duration');
			return { data: null, in_grace_period: false };
		}

		const ttl = await this.client.ttl(key);
		if (ttl === -2) return { data: null, in_grace_period: false };

		const inGracePeriod = ttl > 0 && ttl <= this.grace_period;

		return { data: JSON.parse(response), in_grace_period: inGracePeriod };
	}
	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const _expires_at = parseDate(duration);
		if (!_expires_at) throw new Error('Invalid duration');
		const expires_at = +_expires_at;
		const now = Date.now();
		const expiresSeconds = Math.floor((expires_at - now) / 1000);
		if (expiresSeconds <= 0) throw new Error('Invalid duration');

		await this.client.hSet(key, 'response', JSON.stringify(value));
		await this.client.hSet(key, 'duration', duration);
		await this.client.expire(key, expiresSeconds + this.grace_period);
		return value;
	}

	async delete(key: string): Promise<void> {
		try {
			await this.client.hDel(key, 'response');
		} catch (error) {
			console.error('[RedisDriver] Error deleting response:', error);
		}
	}

	async clear(): Promise<void> {
		await this.client.flushDb();
	}
}
