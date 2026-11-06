import { expect, spyOn, test } from 'bun:test';
import { InMemoryDriver, SQliteDriver, Stash } from './index.ts';

const stash = new Stash('test');

await stash.clear();

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

test('get/set/delete correct value', async () => {
	const key = 'mykey';
	const duration = '1 hour later';
	const value = 'myvalue';
	await stash.set(key, duration, value);
	const result = await stash.get(key, duration);
	expect(result).toBe(value);
	await stash.delete(key);
	const deleted = await stash.get(key, duration);
	expect(deleted).toBe(null);
});

for (const [name, create] of [
	['memory', () => new InMemoryDriver({ grace_period: 2 })],
	['sqlite', () => SQliteDriver.create(':memory:', { grace_period: 2 })],
] as const) {
	test(`${name}: falsy values and null remain cache hits`, async () => {
		const cache = new Stash('values', { driver: create() });
		for (const value of [false, 0, '', null]) {
			await cache.set('key', 'in 1 hour', value);
			expect(
				await cache.wrap<unknown>('key', 'in 1 hour', () => {
					throw new Error('Unexpected miss');
				}),
			).toBe(value);
		}
	});

	test(`${name}: grace uses seconds and expires at the boundary`, async () => {
		const now = Date.parse('2026-11-05T12:00:00Z');
		const clock = spyOn(Date, 'now').mockReturnValue(now);
		try {
			const driver = create();
			await driver.set('key', 'in 1 second', 'value');
			clock.mockReturnValue(now + 1000);
			expect(await driver.get('key', 'in 1 second')).toMatchObject({ data: 'value', in_grace_period: true });
			clock.mockReturnValue(now + 2999);
			expect((await driver.get('key', 'in 1 second')).found).toBe(true);
			clock.mockReturnValue(now + 3000);
			expect((await driver.get('key', 'in 1 second')).found).toBe(false);
			await expect(driver.set('key', 'yesterday', 'value')).rejects.toThrow('Invalid duration');
		} finally {
			clock.mockRestore();
		}
	});

	test(`${name}: clearing preserves other namespaces and refuses ambiguous keys`, async () => {
		const driver = create();
		const first = new Stash('🦊.*[a]', { driver });
		const second = new Stash('other', { driver });
		await first.set('key', 'in 1 hour', 'first');
		await second.set('key', 'in 1 hour', 'second');
		await first.set('nested.key', 'in 1 hour', 'nested');
		expect(await first.get<string>('nested.key', 'in 1 hour')).toBe('nested');
		await first.clear();
		expect(await first.get('key', 'in 1 hour')).toBeNull();
		expect(await first.get('nested.key', 'in 1 hour')).toBeNull();
		expect(await second.get<string>('key', 'in 1 hour')).toBe('second');
		const nested = new Stash('other~nested', { driver });
		await nested.set('key', 'in 1 hour', 'nested');
		await expect(second.clear()).rejects.toThrow('Cannot safely clear');
		expect(await nested.get<string>('key', 'in 1 hour')).toBe('nested');
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test('concurrent misses share work across Stash objects with the same driver', async () => {
	const driver = new InMemoryDriver();
	const first = new Stash('shared', { driver });
	const second = new Stash('shared', { driver });
	const result = deferred<string>();
	const started = deferred<void>();
	let calls = 0;
	const fn = () => {
		calls++;
		started.resolve();
		return result.promise;
	};
	const pending = [first.wrap('key', 'in 1 hour', fn), second.wrap('key', 'in 1 hour', fn)];
	await started.promise;
	result.resolve('value');
	expect(await Promise.all(pending)).toEqual(['value', 'value']);
	expect(calls).toBe(1);
});

for (const mutation of ['delete', 'clear', 'set'] as const) {
	test(`${mutation} supersedes an earlier pending computation`, async () => {
		const cache = new Stash('pending');
		const result = deferred<string>();
		const started = deferred<void>();
		const pending = cache.wrap('key', 'in 1 hour', () => {
			started.resolve();
			return result.promise;
		});
		await started.promise;
		if (mutation === 'clear') await cache.clear();
		else if (mutation === 'delete') await cache.delete('key');
		else await cache.set('key', 'in 1 hour', 'new');
		result.resolve('old');
		expect(await pending).toBe('old');
		expect(await cache.get<string>('key', 'in 1 hour')).toBe(mutation === 'set' ? 'new' : null);
	});
}

test('grace hits share one background refresh and deletion prevents its write', async () => {
	const now = Date.parse('2026-11-05T12:00:00Z');
	const clock = spyOn(Date, 'now').mockReturnValue(now);
	try {
		const cache = new Stash('refresh', { driver: new InMemoryDriver({ grace_period: 2 }) });
		await cache.set('key', 'in 1 second', 'old');
		clock.mockReturnValue(now + 1500);
		const result = deferred<string>();
		const started = deferred<void>();
		let calls = 0;
		const fn = () => {
			calls++;
			started.resolve();
			return result.promise;
		};
		expect(await cache.wrap('key', 'in 1 second', fn)).toBe('old');
		await started.promise;
		expect(await cache.wrap('key', 'in 1 second', fn)).toBe('old');
		expect(calls).toBe(1);
		clock.mockReturnValue(now + 3000);
		const expired = cache.wrap('key', 'in 1 second', fn);
		await cache.delete('key');
		result.resolve('new');
		expect(await expired).toBe('new');
		// Let the refresh continuation enqueue its guarded write, then read after it.
		await result.promise;
		expect(await cache.get('key', 'in 1 second')).toBeNull();
	} finally {
		clock.mockRestore();
	}
});
