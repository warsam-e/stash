import type mongoose from 'mongoose';
import type { StashDuration } from '../types.ts';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base.ts';
import { escapeRegex, expiration, namespacePrefix } from './utils.ts';

type MongoModel = mongoose.Model<mongoose.InferSchemaType<ReturnType<typeof make_schema>>>;

function make_schema(mongoose: typeof import('mongoose')) {
	return new mongoose.Schema({
		key: { type: String, required: true, unique: true },
		response: { type: mongoose.Schema.Types.Mixed },
		duration: { type: String, required: true },
		created_at: { type: Number, required: true },
		expires_at: { type: Number, required: true },
		delete_at: { type: Date },
	});
}

export class MongoDBDriver extends StashDriver {
	private mongo_data!: MongoModel;

	private constructor(opts?: StashDriverOptions) {
		super(opts);
	}

	static async create(url: string, collection_name: string, opts?: StashDriverOptions) {
		const mongoose = await import('mongoose');
		// Validate options before connecting; each driver owns its connection/model.
		const driver = new MongoDBDriver(opts);
		const connection = await mongoose.createConnection(url).asPromise();
		try {
			const model = connection.model('MongoData', make_schema(mongoose), collection_name);
			driver.mongo_data = model;
			await model.init();
			// Keep the numeric expires_at and existing keys readable; add a BSON Date for TTL.
			await model.collection.updateMany({ delete_at: { $exists: false }, expires_at: { $type: 'number' } }, [
				{ $set: { delete_at: { $toDate: { $add: ['$expires_at', driver.grace_period * 1000] } } } },
			]);
			await model.collection.createIndex({ delete_at: 1 }, { expireAfterSeconds: 0 });
			return driver;
		} catch (error) {
			await connection.close();
			throw error;
		}
	}

	async get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>> {
		const existing = await this.mongo_data.findOne({ key }).lean();
		const now = Date.now();
		if (!existing || existing.duration !== duration || now >= existing.expires_at + this.grace_period * 1000) {
			// TTL handles removal; a stale reader must not delete a concurrent write.
			return { data: null, in_grace_period: false, found: false };
		}
		return { data: existing.response as T, in_grace_period: now >= existing.expires_at, found: true };
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const now = Date.now();
		const expiresAt = expiration(duration, now);
		await this.mongo_data.updateOne(
			{ key },
			{
				$set: {
					key,
					response: value,
					duration,
					created_at: now,
					expires_at: expiresAt,
					delete_at: new Date(expiresAt + this.grace_period * 1000),
				},
			},
			{ upsert: true },
		);
		return value;
	}

	async delete(key: string): Promise<void> {
		await this.mongo_data.deleteOne({ key });
	}

	async clear(): Promise<void> {
		await this.mongo_data.deleteMany({});
	}

	async clearNamespace(namespace: string): Promise<void> {
		const prefix = escapeRegex(namespacePrefix(namespace));
		if (await this.mongo_data.exists({ key: { $regex: `^${prefix}.*~`, $options: 's' } })) {
			throw new Error('Cannot safely clear legacy keys containing multiple ~ separators');
		}
		// Exclude ambiguous keys even if one is inserted after the check above.
		await this.mongo_data.deleteMany({ key: { $regex: `^${prefix}[^~]*$` } });
	}
}
