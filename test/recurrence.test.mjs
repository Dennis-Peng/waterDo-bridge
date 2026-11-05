import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError } from '../src/core.mjs';
import { RECURRENCE_PATTERNS, RECURRENCE_TIMEZONE, RECURRENCE_WARNINGS, recurrenceName, nextDueAt, shanghaiDate } from '../src/recurrence.mjs';

const invalid = e => e instanceof BridgeError && e.code === 'INVALID_MUTATION';
test('only five observed basic recurrence encodings are recognized', () => {
  assert.equal(RECURRENCE_TIMEZONE, 'Asia/Shanghai');
  assert.deepEqual(RECURRENCE_PATTERNS, { none: 0, daily: 50331649, weekdays: 75235329, weekly: 67108865, monthly: 83886081 });
  for (const [name, pattern] of Object.entries(RECURRENCE_PATTERNS)) assert.equal(recurrenceName(pattern), name);
  for (const value of [1, -1, 50331650, '50331649', null, undefined, {}, NaN]) assert.equal(recurrenceName(value), null);
  assert.ok(Object.isFrozen(RECURRENCE_PATTERNS));
});
test('daily and weekly preserve Shanghai local clock across calendar boundaries', () => {
  assert.equal(nextDueAt('2026-12-31T23:35:26+08:00', 'daily'), '2027-01-01T15:35:26.000Z');
  assert.equal(nextDueAt('2028-02-28T01:02:03+08:00', 'daily'), '2028-02-28T17:02:03.000Z');
  assert.equal(nextDueAt('2026-12-31T23:35:26+08:00', 67108865), '2027-01-07T15:35:26.000Z');
  assert.equal(nextDueAt('2020-01-01T09:00:00+08:00', 'daily'), '2020-01-02T01:00:00.000Z'); // no catch-up to now
  assert.equal(nextDueAt('2026-11-05T10:00:00.123456789+08:00', 'daily'), '2026-11-06T02:00:00.123456789Z');
});
test('weekdays skips Saturday/Sunday only and retains the original time', () => {
  for (const day of ['06', '07', '08']) assert.equal(nextDueAt(`2026-11-${day}T10:22:33+08:00`, 'weekdays'), '2026-11-09T02:22:33.000Z');
  assert.equal(nextDueAt('2026-11-05T16:30:00Z', 'weekdays'), '2026-11-08T16:30:00.000Z'); // Friday local -> Monday
  assert.equal(nextDueAt('2026-11-09T09:00:00+08:00', 'weekdays'), '2026-11-10T01:00:00.000Z');
});
test('monthly clamps month ends like date-fns, anchored to the preceding due date', () => {
  assert.equal(nextDueAt('2027-01-31T23:59:59+08:00', 'monthly'), '2027-02-28T15:59:59.000Z');
  assert.equal(nextDueAt('2028-01-31T23:59:59+08:00', 'monthly'), '2028-02-29T15:59:59.000Z');
  assert.equal(nextDueAt('2028-02-29T23:59:59+08:00', 'monthly'), '2028-03-29T15:59:59.000Z');
  assert.equal(nextDueAt('2026-12-31T00:15:00+08:00', 'monthly'), '2027-01-30T16:15:00.000Z');
  assert.equal(nextDueAt('2026-04-30T09:00:00+08:00', 'monthly'), '2026-05-30T01:00:00.000Z');
});
test('month-end clamp deliberately drifts and does not restore a historical 31st anchor', () => {
  const february = nextDueAt('2027-01-31T09:30:00+08:00', 'monthly');
  assert.equal(february, '2027-02-28T01:30:00.000Z');
  const march = nextDueAt(february, 'monthly');
  assert.equal(march, '2027-03-28T01:30:00.000Z');
  assert.ok(RECURRENCE_WARNINGS.some(w => w.includes('31日→28日→28日')));
});
test('weekdays policy explicitly differs from the observed Web same-week midnight branch', () => {
  assert.equal(nextDueAt('2026-11-02T09:30:00+08:00', 'weekdays'), '2026-11-03T01:30:00.000Z');
  assert.equal(nextDueAt('2026-11-06T09:30:00+08:00', 'weekdays'), '2026-11-09T01:30:00.000Z');
  assert.ok(RECURRENCE_WARNINGS.some(w => w.includes('网页') && w.includes('午夜') && w.includes('Asia/Shanghai')));
  assert.ok(RECURRENCE_WARNINGS.some(w => w.includes('节假日') && w.includes('调休')));
  assert.ok(Object.isFrozen(RECURRENCE_WARNINGS));
});
test('calendar calculations are independent of host process timezone', () => {
  const before = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      assert.equal(nextDueAt('2026-11-06T16:30:00Z', 'weekdays'), '2026-11-08T16:30:00.000Z');
      assert.equal(nextDueAt('2027-01-31T09:30:00+08:00', 'monthly'), '2027-02-28T01:30:00.000Z');
      assert.equal(shanghaiDate('2026-11-05T16:00:00Z'), 20261106);
    }
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});
test('done_date is a numeric Shanghai yyyyMMdd independent of process timezone', () => {
  assert.equal(shanghaiDate('2026-11-05T15:59:59.999Z'), 20261105);
  assert.equal(shanghaiDate('2026-11-05T16:00:00Z'), 20261106);
  assert.equal(shanghaiDate('2026-12-31T18:00:00-05:00'), 20270101);
});
test('invalid calendar timestamps, unsupported patterns and overflow are rejected', () => {
  for (const input of [null, 42, '', '2026-11-05', '2026-11-05T10:00:00', '2026-02-29T10:00:00Z', '2026-11-05T25:00:00Z',
    '2026-11-05T10:00:00-00:00', '2026-11-05T10:00:00+24:00', '2026-11-05T10:00:00.1234567890Z', '0000-01-01T00:00:00Z']) {
    assert.throws(() => nextDueAt(input, 'daily'), invalid);
    assert.throws(() => shanghaiDate(input), invalid);
  }
  for (const recurrence of ['none', 'custom', 'ignoreExpired', 1, null, {}, 'toString']) assert.throws(() => nextDueAt('2026-11-05T10:00:00Z', recurrence), invalid);
  assert.throws(() => nextDueAt('9999-12-31T10:00:00+08:00', 'daily'), invalid);
  assert.throws(() => nextDueAt('9999-12-31T10:00:00+08:00', 'monthly'), invalid);
});
test('historical Shanghai DST follows local calendar; ambiguous/nonexistent local clocks are not guessed', () => {
  assert.equal(nextDueAt('1991-04-13T09:00:00+08:00', 'daily'), '1991-04-14T00:00:00.000Z');
  assert.throws(() => nextDueAt('1991-04-13T02:30:00+08:00', 'daily'), invalid);
  assert.throws(() => nextDueAt('1991-09-14T01:30:00+09:00', 'daily'), invalid);
});
