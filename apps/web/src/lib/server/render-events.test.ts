import { describe, expect, it, vi } from 'vitest';
import {
	computeCacheHitRate,
	computeIpHash,
	enumerateDayBuckets,
	fillDayBuckets,
	recordRenderEvent,
	resolveDateRange,
	utcDayString,
	type RenderEventDb
} from './render-events';

// We avoid touching the real Drizzle client in unit tests; the
// `RenderEventDb` shape only needs `insert(...).values(...)` for the
// fire-and-forget path under test.
function makeFakeDb(behavior: 'ok' | 'throw'): RenderEventDb {
	const values = vi.fn(async () => {
		if (behavior === 'throw') throw new Error('boom');
		return undefined;
	});
	const insert = vi.fn(() => ({ values }));
	// Cast through unknown — vitest only needs the call surface used by
	// `recordRenderEvent`, not the full drizzle generic.
	return { insert } as unknown as RenderEventDb;
}

describe('utcDayString', () => {
	it('formats a Date as YYYY-MM-DD in UTC', () => {
		expect(utcDayString(new Date('2026-05-16T03:14:00Z'))).toBe('2026-05-16');
	});

	it('does not roll over near midnight UTC due to local TZ', () => {
		// A timestamp just before midnight UTC must still be the same day.
		expect(utcDayString(new Date('2026-05-16T23:59:59.999Z'))).toBe('2026-05-16');
		// And one millisecond later flips into the next day.
		expect(utcDayString(new Date('2026-05-17T00:00:00.000Z'))).toBe('2026-05-17');
	});
});

describe('resolveDateRange', () => {
	const now = new Date('2026-05-16T12:00:00Z');

	it('defaults to last 30 days when nothing is provided', () => {
		const { from, to } = resolveDateRange(undefined, now);
		expect(to).toEqual(now);
		expect(to.getTime() - from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
	});

	it('honours a custom days window', () => {
		const { from, to } = resolveDateRange({ days: 7 }, now);
		expect(to).toEqual(now);
		expect(to.getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it('uses both from and to when provided, with ISO mirrors', () => {
		const from = new Date('2026-05-01T00:00:00Z');
		const to = new Date('2026-05-15T00:00:00Z');
		expect(resolveDateRange({ from, to }, now)).toEqual({
			from,
			to,
			fromIso: from.toISOString(),
			toIso: to.toISOString()
		});
	});

	it('infers `to` as now when only `from` is provided', () => {
		const from = new Date('2026-05-10T00:00:00Z');
		expect(resolveDateRange({ from }, now)).toEqual({
			from,
			to: now,
			fromIso: from.toISOString(),
			toIso: now.toISOString()
		});
	});

	it('infers `from` as to - days when only `to` is provided', () => {
		const to = new Date('2026-05-10T00:00:00Z');
		const { from } = resolveDateRange({ to, days: 5 }, now);
		expect(to.getTime() - from.getTime()).toBe(5 * 24 * 60 * 60 * 1000);
	});

	it('throws on an inverted range (misconfig is a bug, not a zero result)', () => {
		const from = new Date('2026-05-15T00:00:00Z');
		const to = new Date('2026-05-10T00:00:00Z');
		expect(() => resolveDateRange({ from, to }, now)).toThrow(/from must be strictly before to/);
	});

	it('throws when `from` and `to` are equal (zero-length window)', () => {
		const at = new Date('2026-05-10T00:00:00Z');
		expect(() => resolveDateRange({ from: at, to: at }, now)).toThrow();
	});
});

describe('enumerateDayBuckets', () => {
	it('yields one entry per UTC day inclusive of the from-day and excluding to', () => {
		const from = new Date('2026-05-10T00:00:00Z');
		const to = new Date('2026-05-13T00:00:00Z');
		// [10, 11, 12] — `to` itself is excluded because the window is [from, to)
		expect(enumerateDayBuckets(from, to)).toEqual(['2026-05-10', '2026-05-11', '2026-05-12']);
	});

	it('handles a partial start-day (from mid-day) by including the whole UTC day', () => {
		const from = new Date('2026-05-10T17:30:00Z');
		const to = new Date('2026-05-12T03:00:00Z');
		// The 12th is partially covered, so it's a real bucket the chart
		// needs to render — include it.
		expect(enumerateDayBuckets(from, to)).toEqual(['2026-05-10', '2026-05-11', '2026-05-12']);
	});

	it('crosses month boundaries correctly', () => {
		const from = new Date('2026-04-29T00:00:00Z');
		const to = new Date('2026-05-02T00:00:00Z');
		expect(enumerateDayBuckets(from, to)).toEqual(['2026-04-29', '2026-04-30', '2026-05-01']);
	});

	it('returns an empty array for an inverted or zero-length window', () => {
		const from = new Date('2026-05-12T00:00:00Z');
		const to = new Date('2026-05-10T00:00:00Z');
		expect(enumerateDayBuckets(from, to)).toEqual([]);
		expect(enumerateDayBuckets(from, from)).toEqual([]);
	});

	it('returns the full 30-day default window without gaps', () => {
		const from = new Date('2026-04-16T00:00:00Z');
		const to = new Date('2026-05-16T00:00:00Z');
		const days = enumerateDayBuckets(from, to);
		expect(days).toHaveLength(30);
		expect(days[0]).toBe('2026-04-16');
		expect(days[29]).toBe('2026-05-15');
	});
});

describe('fillDayBuckets', () => {
	it('zero-fills missing days while preserving present totals', () => {
		const rows = [
			{ date: '2026-05-10', total: 3 },
			{ date: '2026-05-12', total: 7 }
		];
		const days = ['2026-05-10', '2026-05-11', '2026-05-12'];
		expect(fillDayBuckets(rows, days)).toEqual([
			{ date: '2026-05-10', total: 3 },
			{ date: '2026-05-11', total: 0 },
			{ date: '2026-05-12', total: 7 }
		]);
	});

	it('returns an empty array when the day list is empty', () => {
		expect(fillDayBuckets([{ date: '2026-05-10', total: 5 }], [])).toEqual([]);
	});

	it('ignores rows for dates not in the requested window', () => {
		const rows = [
			{ date: '2026-05-09', total: 99 },
			{ date: '2026-05-10', total: 3 }
		];
		const days = ['2026-05-10', '2026-05-11'];
		expect(fillDayBuckets(rows, days)).toEqual([
			{ date: '2026-05-10', total: 3 },
			{ date: '2026-05-11', total: 0 }
		]);
	});
});

describe('computeCacheHitRate', () => {
	it('returns null for an empty window (no meaningful rate)', () => {
		expect(computeCacheHitRate(0, 0)).toBeNull();
	});

	it('returns 0 when there are events but no hits', () => {
		expect(computeCacheHitRate(0, 10)).toBe(0);
	});

	it('returns 1 when every event is a hit', () => {
		expect(computeCacheHitRate(5, 5)).toBe(1);
	});

	it('returns a fractional ratio for mixed events', () => {
		expect(computeCacheHitRate(3, 12)).toBeCloseTo(0.25);
	});

	it('treats negative or zero totals as no-data (defensive)', () => {
		expect(computeCacheHitRate(0, -1)).toBeNull();
	});
});

describe('computeIpHash', () => {
	const day = new Date('2026-05-16T12:00:00Z');

	it('returns null when no salt is configured', () => {
		expect(computeIpHash('203.0.113.10', null, day)).toBeNull();
		expect(computeIpHash('203.0.113.10', '', day)).toBeNull();
	});

	it('returns null when no IP is provided', () => {
		expect(computeIpHash(null, 'salt', day)).toBeNull();
		expect(computeIpHash(undefined, 'salt', day)).toBeNull();
		expect(computeIpHash('', 'salt', day)).toBeNull();
	});

	it('returns a stable sha256 hex (64 chars) for a given salt+day+ip', () => {
		const h = computeIpHash('203.0.113.10', 'salt-x', day);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(computeIpHash('203.0.113.10', 'salt-x', day)).toBe(h);
	});

	it('rotates daily — same IP on different days produces different hashes', () => {
		const a = computeIpHash('203.0.113.10', 'salt-x', new Date('2026-05-16T12:00:00Z'));
		const b = computeIpHash('203.0.113.10', 'salt-x', new Date('2026-05-17T12:00:00Z'));
		expect(a).not.toBe(b);
	});

	it('differs across IPs even with the same salt + day', () => {
		const a = computeIpHash('203.0.113.10', 'salt-x', day);
		const b = computeIpHash('203.0.113.11', 'salt-x', day);
		expect(a).not.toBe(b);
	});

	it('differs across salts (a salt rotation invalidates correlations)', () => {
		const a = computeIpHash('203.0.113.10', 'salt-x', day);
		const b = computeIpHash('203.0.113.10', 'salt-y', day);
		expect(a).not.toBe(b);
	});
});

describe('recordRenderEvent', () => {
	const baseInput = {
		source: 'on-the-fly',
		canvasId: '11111111-1111-1111-1111-111111111111',
		ownerUserId: 'user-1',
		requesterUserId: 'user-1',
		apiKeyId: null,
		format: 'png',
		paramsHash: 'deadbeef',
		cacheHit: false,
		durationMs: 42,
		statusCode: 200
	};

	it('inserts a row via the injected client', async () => {
		const db = makeFakeDb('ok');
		await recordRenderEvent(baseInput, db);
		expect(db.insert).toHaveBeenCalledOnce();
	});

	it('swallows DB errors so render paths never observe an observability failure', async () => {
		const db = makeFakeDb('throw');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// The promise must resolve cleanly — never reject.
		await expect(recordRenderEvent(baseInput, db)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('passes ipHash=null when no salt is configured (vitest stub leaves env empty)', async () => {
		const db = makeFakeDb('ok');
		// We can't easily reach the values() spy from outside the closure;
		// reach it via the mocked insert chain instead.
		const insert = db.insert as unknown as ReturnType<typeof vi.fn>;
		await recordRenderEvent({ ...baseInput, ip: '203.0.113.10' }, db);
		const valuesFn = insert.mock.results[0].value.values as ReturnType<typeof vi.fn>;
		const row = valuesFn.mock.calls[0][0];
		expect(row.ipHash).toBeNull();
		expect(row.source).toBe('on-the-fly');
		expect(row.canvasId).toBe(baseInput.canvasId);
		expect(row.cacheHit).toBe(false);
	});
});
