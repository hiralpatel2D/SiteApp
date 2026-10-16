import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  averageEmbedding,
  decryptTemplate,
  encryptTemplate,
} from '../src/attendance/face/template';

const embedding = Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 10);

describe('face templates', () => {
  it('round-trips an embedding through encryption', () => {
    const key = randomBytes(32);
    const blob = encryptTemplate(embedding, key);
    expect(blob.length).toBe(12 + 16 + 1024 * 4);
    const back = decryptTemplate(blob, key);
    expect(back).toHaveLength(embedding.length);
    back.forEach((v, i) => expect(Math.abs(v - embedding[i]!)).toBeLessThan(1e-6));
  });

  it('uses a fresh IV each time', () => {
    const key = randomBytes(32);
    expect(encryptTemplate(embedding, key).equals(encryptTemplate(embedding, key))).toBe(false);
  });

  it('throws with the wrong key', () => {
    const blob = encryptTemplate(embedding, randomBytes(32));
    expect(() => decryptTemplate(blob, randomBytes(32))).toThrow();
  });

  it('throws on a tampered blob', () => {
    const key = randomBytes(32);
    const blob = encryptTemplate(embedding, key);
    blob[blob.length - 1]! ^= 1;
    expect(() => decryptTemplate(blob, key)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () =>
    expect(() => encryptTemplate(embedding, randomBytes(16))).toThrow());

  it('averages embeddings to a unit-length vector', () => {
    const avg = averageEmbedding([
      [1, 2, 3],
      [3, 2, 1],
      [2, 2, 2],
    ]);
    const norm = Math.sqrt(avg.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
    expect(avg[0]).toBeCloseTo(avg[1]!, 10);
  });

  it('refuses to average an empty or ragged list', () => {
    expect(() => averageEmbedding([])).toThrow();
    expect(() => averageEmbedding([[1, 2], [1]])).toThrow();
  });
});
