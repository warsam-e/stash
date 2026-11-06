import { parseDate } from 'chrono-node';
import type { StashDuration } from '../types.ts';

/** Parse all driver durations against the same clock and reject past expiration dates. */
export function expiration(duration: StashDuration, now = Date.now()): number {
	const date = parseDate(duration, new Date(now));
	if (!date || !Number.isFinite(+date) || +date <= now) throw new Error('Invalid duration');
	return +date;
}

export function namespacePrefix(namespace: string): string {
	if (namespace.includes('~')) throw new Error('Cannot safely clear a namespace containing ~');
	return `${namespace}~`;
}

/** Legacy keys cannot distinguish nested namespaces from item keys containing ~. */
export function assertUnambiguousKeys(keys: string[], prefix: string): void {
	if (keys.some((key) => key.slice(prefix.length).includes('~'))) {
		throw new Error('Cannot safely clear legacy keys containing multiple ~ separators');
	}
}

export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
