import assert from 'node:assert/strict';
import test from 'node:test';
import { toIsoMicros } from './timestamps';

test('PostgreSQL timestamps keep microseconds and are normalised to UTC', () => {
  assert.equal(toIsoMicros('2026-11-27 21:39:30.022123+00'), '2026-11-27T21:39:30.022123Z');
  assert.equal(toIsoMicros('2026-11-27 15:39:30.022123-06'), '2026-11-27T21:39:30.022123Z');
  assert.equal(toIsoMicros('2026-11-28 03:09:30.5+05:30'), '2026-11-27T21:39:30.500000Z');
  assert.equal(toIsoMicros('2026-11-27 21:39:30+00'), '2026-11-27T21:39:30.000000Z');
  assert.equal(toIsoMicros(new Date('2026-11-27T21:39:30.022Z')), '2026-11-27T21:39:30.022000Z');
});

test('formatted timestamps sort correctly as strings', () => {
  const values = ['2026-11-27 21:39:30.000002+00', '2026-11-27 15:39:30.000001-06', '2026-11-27 21:39:30.000010+00'].map(toIsoMicros);
  assert.deepEqual([...values].sort(), [values[1], values[0], values[2]]);
});
