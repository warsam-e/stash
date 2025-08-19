import type { StashDuration } from '../types';

/** Response from fetching data from a stash, used in implementing stash drivers. */
export type StashDriverResponse<T> = { data?: T | null; in_grace_period: boolean };

/**
 * A Stash Driver.
 *
 * This is the base class for all stash drivers, not to be instantiated directly.
 */
export abstract class StashDriver {
	grace_period = 5 * 60;
	abstract get<T>(key: string, duration: StashDuration): Promise<StashDriverResponse<T>>;
	abstract set<T>(key: string, duration: StashDuration, value: T): Promise<T>;
}
