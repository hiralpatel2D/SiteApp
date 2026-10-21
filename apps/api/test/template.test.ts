import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  averageEmbedding,
  decryptTemplate,
  encryptTemplate,
} from '../src/attendance/face/template';
import { createHumanEngine } from '../src/attendance/face/engine';

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

  it('averages embeddings element-wise, with no rescaling', () => {
    expect(
      averageEmbedding([
        [1, 2, 3],
        [3, 2, 1],
        [2, 5, 2],
      ]),
    ).toEqual([2, 3, 2]);
  });

  describe("stays in the engine's raw embedding space (faceres descriptors are not unit length)", () => {
    // Raw-scale like real faceres output: values 0..2, L2 norm about 6.
    const v = Array.from({ length: 1024 }, (_, i) => 0.15 * (1 + Math.sin(i * 0.37)));
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    const similarity = createHumanEngine().similarity;

    it('uses a raw-scale vector', () => {
      expect(norm).toBeGreaterThan(5);
      expect(norm).toBeLessThan(8);
    });

    it('the mean of a vector with itself still matches it', () =>
      expect(similarity(averageEmbedding([v, v]), v)).toBeGreaterThanOrEqual(0.99));

    it('a unit-length template is pulled away from raw frames (why it is never normalised)', () => {
      const unit = v.map((x) => x / norm);
      expect(similarity(unit, v)).toBeLessThan(0.95);
      // A same-person frame at the edge of the default 0.50 threshold: it matches the raw
      // template but would fail against a normalised one.
      const frame = v.map((x, i) => x + 0.4 * Math.sin(i * 7.3));
      expect(similarity(averageEmbedding([v, v]), frame)).toBeGreaterThanOrEqual(0.5);
      expect(similarity(unit, frame)).toBeLessThan(0.5);
    });
  });

  it('refuses to average an empty or ragged list', () => {
    expect(() => averageEmbedding([])).toThrow();
    expect(() => averageEmbedding([[1, 2], [1]])).toThrow();
  });
});
