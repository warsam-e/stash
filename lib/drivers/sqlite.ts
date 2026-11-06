import type { Database } from 'bun:sqlite';
import { BunDB } from 'bun.db';
import type { StashDuration } from '../types.ts';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base.ts';
import { assertUnambiguousKeys, expiration, namespacePrefix } from './utils.ts';

interface SQLiteEntry<T> {
	response: T;
	duration: StashDuration;
	created_at: number;
	expires_at: number;
}

export class SQliteDriver extends StashDriver {
	#client: BunDB;
	#database: Database;
	#tail: Promise<unknown> = Promise.resolve();

	private constructor(path: string, opts?: StashDriverOptions) {
		super(opts);
		this.#client = new BunDB(path);
		// bun.db exposes the underlying connection through its driver. Keep its
		// key/path semantics while using conditional SQL for maintenance.
		this.#database = (this.#client.driver as unknown as { database: Database }).database;
		setInterval(() => {
			void this.#write(async () => {
				const now = Date.now();
				this.#maintain((_key, entry) => now >= entry.expires_at + this.grace_period * 1000);
			}).catch((error) => console.error('[SQliteDriver] Cleanup error:', error));
		}, 1000).unref();
	}

	static create(path: string, opts?: StashDriverOptions) {
		return new SQliteDriver(path, opts);
	}

	#write<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.catch(() => {});
		return result;
	}

	async get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>> {
		await this.#tail;
		const existing = await this.#client.get<SQLiteEntry<T>>(key);
		const now = Date.now();
		if (!existing || existing.duration !== duration || now >= existing.expires_at + this.grace_period * 1000) {
			return { data: null, in_grace_period: false, found: false };
		}
		return { data: existing.response, in_grace_period: now >= existing.expires_at, found: true };
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const now = Date.now();
		const entry: SQLiteEntry<T> = {
			response: value,
			duration,
			created_at: now,
			expires_at: expiration(duration, now),
		};
		await this.#write(() => this.#client.set(key, entry));
		return value;
	}

	async delete(key: string): Promise<void> {
		await this.#write(() => this.#client.delete(key));
	}

	async clear(): Promise<void> {
		await this.#write(() => this.#client.deleteAll());
	}

	async clearNamespace(namespace: string): Promise<void> {
		const legacyPrefix = namespacePrefix(namespace);
		// QuickDB treats the first component literally and parses the remainder
		// as a lodash-style object path, including bracket notation.
		const dot = legacyPrefix.indexOf('.');
		const prefix =
			dot < 0
				? legacyPrefix
				: `${legacyPrefix.slice(0, dot)}.${this.#path(legacyPrefix.slice(dot + 1)).join('.')}`;
		await this.#write(async () => {
			this.#maintain((key) => {
				if (!key.startsWith(prefix)) return false;
				assertUnambiguousKeys([key], prefix);
				return true;
			});
		});
	}

	#path(path: string): string[] {
		const parts: string[] = path.startsWith('.') ? [''] : [];
		const tokens = /[^.[\]]+|\[(["'])((?:\\.|(?!\1).)*)\1\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;
		for (const match of path.matchAll(tokens)) {
			parts.push(match[1] ? match[2].replace(/\\(\\)?/g, '$1') : match[0]);
		}
		return parts;
	}

	// Entries using dotted keys may be nested inside a bun.db row. Traverse
	// those containers, stopping at cache entries so responses remain opaque.
	#prune(value: unknown, key: string, remove: (key: string, entry: SQLiteEntry<unknown>) => boolean): unknown {
		if (!value || typeof value !== 'object') return value;
		if ('expires_at' in value && typeof value.expires_at === 'number' && 'duration' in value) {
			return remove(key, value as SQLiteEntry<unknown>) ? undefined : value;
		}
		let changed = false;
		const copy = Array.isArray(value) ? [...value] : { ...value };
		for (const [part, child] of Object.entries(value)) {
			const next = this.#prune(child, `${key}.${part}`, remove);
			if (next === child) continue;
			changed = true;
			if (next === undefined) Reflect.deleteProperty(copy, part);
			else
				Object.defineProperty(copy, part, {
					value: next,
					enumerable: true,
					writable: true,
					configurable: true,
				});
		}
		return changed ? (Object.keys(copy).length ? copy : undefined) : value;
	}

	#maintain(remove: (key: string, entry: SQLiteEntry<unknown>) => boolean): void {
		this.#database
			.transaction(() => {
				const rows = this.#database.query<{ ID: string; json: string }, []>('SELECT ID, json FROM json').all();
				for (const row of rows) {
					const original: unknown = JSON.parse(row.json);
					const next = this.#prune(original, row.ID, remove);
					if (next === original) continue;
					if (next === undefined)
						this.#database.query('DELETE FROM json WHERE ID = ? AND json = ?').run(row.ID, row.json);
					else
						this.#database
							.query('UPDATE json SET json = ? WHERE ID = ? AND json = ?')
							.run(JSON.stringify(next), row.ID, row.json);
				}
			})
			.immediate();
	}
}
