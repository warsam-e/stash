import type { StashDriver } from './drivers';

/**
 * Options for configuring the stash behavior.
 */
export interface StashOptions {
	/**
	 * The driver to use for stashing.
	 */
	driver?: StashDriver;
}

/**
 * The duration of the stashed item.
 *
 * Typically a string in the format of "1 hour later",
 * "in 2 days", "next Friday at 3pm"
 *
 * see {@link https://www.npmjs.com/package/chrono-node chrono-node}.
 */
export type StashDuration = string;
