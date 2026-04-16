import { parseDate } from 'chrono-node';
import { connect, type InferSchemaType, type Model, model, Schema } from 'mongoose';
import type { StashDuration } from '../types';
import { StashDriver, type StashDriverOptions, type StashDriverResponse } from './base';

const schema = new Schema({
	key: { type: String, required: true, unique: true },
	response: { type: Schema.Types.Mixed },
	duration: { type: String, required: true },
	created_at: { type: Number, required: true },
	expires_at: { type: Number, required: true },
});
type MongoDataType = InferSchemaType<typeof schema>;

export class MongoDBDriver extends StashDriver {
	mongo_data: Model<MongoDataType>;

	private constructor(collection_name: string, opts?: StashDriverOptions) {
		super(opts);
		this.mongo_data = model('MongoData', schema, collection_name);
	}

	static async create(url: string, collection_name: string, opts?: StashDriverOptions) {
		await connect(url);

		const inst = new MongoDBDriver(collection_name, opts);
		await inst.mongo_data.init();
		return inst;
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

		return { data: existing.response, in_grace_period };
	}

	async set<T>(key: string, duration: StashDuration, value: T): Promise<T> {
		const now = new Date();
		const expires_at_date = parseDate(duration, now);
		if (!expires_at_date) throw new Error('Invalid duration');
		const expires_at = expires_at_date.getTime();

		await this.mongo_data.create({
			key,
			response: value,
			duration,
			created_at: now.getTime(),
			expires_at,
		});

		return value;
	}

	async delete(key: string): Promise<void> {
		await this.mongo_data.deleteOne({ key });
	}

	async clear(): Promise<void> {
		await this.mongo_data.deleteMany({});
	}
}
