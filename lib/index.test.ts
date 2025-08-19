import { expect, test } from 'bun:test';
import { Stash } from './index';

const stash = new Stash('test');

test('wrap caches and returns value', async () => {
	let callCount = 0;
	const orig_fn = async () => {
		callCount++;
		return 'value';
	};
	const fn = () => stash.wrap('key', '1 hour later', () => orig_fn());
	const v1 = await fn();
	const v2 = await fn();
	expect(v1).toBe('value');
	expect(v2).toBe('value');
	expect(callCount).toBe(1);
});

test('wrap calls fn again after duration mismatch', async () => {
	let callCount = 0;
	const orig_fn = async () => {
		callCount++;
		return 'foo';
	};
	const fn = (duration: string) => stash.wrap('key1', duration, () => orig_fn());
	await fn('in 1 hour');
	await fn('in 1 hour');
	await fn('in 2 hours');
	expect(callCount).toBe(2);
});
