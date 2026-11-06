import { createClient } from 'redis';
import type { StashDuration } from '../types.ts';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base.ts';
import { assertUnambiguousKeys, expiration, namespacePrefix } from './utils.ts';

const _create_client = (url: string) =>
	createClient({ url }).on('error', (error) => console.error('[RedisDriver] Client error:', error));
type Client = ReturnType<typeof _create_client>;

/** Redis cache driver. Keys retain the legacy hash format. */
export class RedisDriver extends StashDriver {
	client: Client;

	private constructor(url: string, opts?: StashDriverOptions) {
		super(opts);
		this.client = _create_client(url);
	}

	static async create(url: string, opts?: StashDriverOptions) {
		// Validate options before opening a connection.
		const driver = new RedisDriver(url, opts);
		await driver.client.connect();
		return driver;
	}

	async get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>> {
		// A transaction keeps the hash and remaining lifetime from the same version.
		const [fields, ttl] = await this.client.multi().hmGet(key, ['response', 'duration']).pTTL(key).exec<'typed'>();
		const [response, storedDuration] = fields;
		if (response === null || storedDuration !== duration || ttl < 0) {
			return { data: null, in_grace_period: false, found: false };
		}
		return {
			data: JSON.parse(response) as T,
			in_grace_period: this.grace_period > 0 && ttl <= this.grace_period * 1000,
			found: true,
		};
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const expiresAt = expiration(duration) + this.grace_period * 1000;
		const response = JSON.stringify(value);
		if (response === undefined) throw new Error('Value must be JSON serializable');
		await this.client.multi().hSet(key, { response, duration }).pExpireAt(key, Math.ceil(expiresAt)).exec();
		return value;
	}

	async delete(key: string): Promise<void> {
		await this.client.del(key);
	}

	/** Clear the entire selected database when explicitly called on the driver. */
	async clear(): Promise<void> {
		await this.client.flushDb();
	}

	async clearNamespace(namespace: string): Promise<void> {
		const prefix = namespacePrefix(namespace);
		const pattern = `${prefix.replace(/[\\*?[\]]/g, '\\$&')}*`;
		const keys: string[] = [];
		for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
			keys.push(...batch);
		}
		assertUnambiguousKeys(keys, prefix);
		for (let index = 0; index < keys.length; index += 500) {
			await this.client.del(keys.slice(index, index + 500));
		}
	}
}
