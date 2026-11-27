import { types, type CustomTypesConfig } from 'pg';

const TIMESTAMPTZ_OID = 1184;

/**
 * Keeps `timestamptz` values as PostgreSQL text. JavaScript Dates hold only
 * milliseconds, but PostgreSQL stores microseconds: a cursor built from a
 * truncated Date can skip rows that share the same millisecond.
 */
export const preciseTimestampTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === TIMESTAMPTZ_OID ? (value: string) => value : types.getTypeParser(oid, format)) as CustomTypesConfig['getTypeParser'],
};

const POSTGRES_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Formats a PostgreSQL timestamptz (text or Date) as UTC ISO-8601 with microsecond precision. */
export function toIsoMicros(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  const match = POSTGRES_TIMESTAMP.exec(value);
  if (!match) return toIsoMicros(new Date(value));
  const [, date, time, fraction = '', zone] = match;
  const offset = zone === 'Z' ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const millis = new Date(`${date}T${time}.${fraction.padEnd(3, '0').slice(0, 3)}${offset}`);
  if (Number.isNaN(millis.getTime())) throw new Error('Invalid timestamp');
  // Offsets are whole minutes, so converting to UTC never changes the fraction.
  return millis.toISOString().replace(/\.\d{3}Z$/, `.${fraction.padEnd(6, '0')}Z`);
}
