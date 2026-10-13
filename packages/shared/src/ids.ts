import { v7, validate } from 'uuid';

/** New time-ordered UUIDv7 identifier. */
export function newId(): string {
  return v7();
}

export function isId(v: unknown): v is string {
  return typeof v === 'string' && validate(v);
}
