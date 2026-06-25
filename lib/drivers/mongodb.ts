import { parseDate } from 'chrono-node';
import type mongoose from 'mongoose';
import type { StashDuration } from '../types';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base';

type MongoModel = mongoose.Model<mongoose.InferSchemaType<ReturnType<typeof make_schema>>>;

function make_schema(mongoose: typeof import('mongoose')) {
	return new mongoose.Schema({
		key: { type: String, required: true, unique: true },
		response: { type: mongoose.Schema.Types.Mixed },
		duration: { type: String, required: true },
		created_at: { type: Number, required: true },
		expires_at: { type: Number, required: true },
	});
}

export class MongoDBDriver extends StashDriver {
	private mongo_data: MongoModel;

	private constructor(mongo_data: MongoModel, opts?: StashDriverOptions) {
		super(opts);
		this.mongo_data = mongo_data;
	}

	static async create(url: string, collection_name: string, opts?: StashDriverOptions) {
		const mongoose = await import('mongoose');

		const schema = make_schema(mongoose);

		await mongoose.connect(url);

		const mongo_data = mongoose.models.MongoData ?? mongoose.model('MongoData', schema, collection_name);

		await mongo_data.init();

		return new MongoDBDriver(mongo_data, opts);
	}

	async get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>> {
		const existing = await this.mongo_data.findOne({ key }).lean();
		if (!existing) return { data: null, in_grace_period: false };

		if (existing.duration !== duration) {
			await this.mongo_data.deleteOne({ key });
			return { data: null, in_grace_period: false };
		}

		const current_time = Date.now();
		const has_expired = current_time > existing.expires_at;
		const grace_expire_at = existing.expires_at + this.grace_period;
		const in_grace_period = has_expired && current_time < grace_expire_at;

		if (has_expired && !in_grace_period) {
			await this.mongo_data.deleteOne({ key });
			return { data: null, in_grace_period: false };
		}

		return { data: existing.response as T, in_grace_period };
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const now = new Date();
		const expires_at_date = parseDate(duration, now);
		if (!expires_at_date) throw new Error('Invalid duration');

		await this.mongo_data.updateOne(
			{ key },
			{
				key,
				response: value,
				duration,
				created_at: now.getTime(),
				expires_at: expires_at_date.getTime(),
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
}
