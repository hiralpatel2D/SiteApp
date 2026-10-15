import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { isUniqueViolation, unwrapDbError } from '../src/db/errors';

const pgErr = Object.assign(new Error('dup'), { code: '23505', constraint: 'c_unique' });

describe('db errors', () => {
  it('unwraps a DrizzleQueryError cause', () => {
    const wrapped = new DrizzleQueryError('select 1', [], pgErr);
    expect(unwrapDbError(wrapped)).toBe(pgErr);
  });
  it('returns other errors as is', () => {
    const e = new Error('x');
    expect(unwrapDbError(e)).toBe(e);
    expect(unwrapDbError('s')).toBe('s');
  });
  it('detects unique violations by constraint', () => {
    expect(isUniqueViolation(new DrizzleQueryError('q', [], pgErr), 'c_unique')).toBe(true);
    expect(isUniqueViolation(pgErr, 'other')).toBe(false);
    expect(isUniqueViolation(null, 'c_unique')).toBe(false);
    expect(isUniqueViolation(new Error('x'), 'c_unique')).toBe(false);
  });
});
