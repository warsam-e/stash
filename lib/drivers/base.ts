import type { StashDuration } from '../types';

/** Response from fetching data from a stash, used in implementing stash drivers. */
export type StashDriverResponse<T> = { data: T | null; in_grace_period: boolean };

/** Base configuration options for stash drivers. */
export interface StashDriverOptions {
	grace_period?: number;
}

/**
 * A Stash Driver.
 *
 * This is the base class for all stash drivers, not to be instantiated directly.
 */
export abstract class StashDriver {
	grace_period: number;
	constructor(opts?: StashDriverOptions) {
		const default_grace_period = 5 * 60;
		this.grace_period = opts?.grace_period ?? default_grace_period;
	}
	abstract get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>>;
	abstract set<T>(key: string, duration: StashDuration, value: T): Promise<T>;
	abstract delete(key: string): Promise<void>;
	abstract clear(): Promise<void>;
}
