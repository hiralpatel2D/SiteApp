import type { FaceEngine, FaceReading } from './types';

/**
 * Two frames whose 32×32 greyscale downscales differ by less than this mean absolute
 * difference (on 0..255) are near-identical: one picture sent twice, not a live person.
 * Measured basis: re-encodes of the same picture score well below 1.0, while a 1 px hand
 * shake between two live frames already scores 1.3–2.0, so 1.0 sits between the two.
 *
 * There is deliberately no embedding-based rule: faceSimilarity saturates at 1.00 for any
 * raw distance up to about 4, which genuine same-person frames 250 ms apart often reach.
 */
export const NEAR_IDENTICAL_MAD = 1.0;

/**
 * True when any two frames are byte-identical: one photo sent more than once. This is the replay
 * check registration and check-in use now. The stricter near-identical rule (framesDistinct below)
 * refused still, genuine people, and its threshold is not measured on real phones.
 */
export function hasDuplicateFrames(jpegs: Buffer[]): boolean {
  return jpegs.some((a, i) => jpegs.some((b, j) => j > i && a.equals(b)));
}

/** Frames of one check must be the same person: every pair at least this similar. */
export const SAME_PERSON_MIN = 0.5;

/** Mean absolute difference of two equal-length greyscale buffers; 255 when sizes differ. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

function pairs(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

/**
 * False when the frames look replayed: any two byte-identical, or any two near-identical
 * (downscale MAD < NEAR_IDENTICAL_MAD). Embeddings are not used (see NEAR_IDENTICAL_MAD).
 */
export function framesDistinct(jpegs: Buffer[], readings: FaceReading[]): boolean {
  const idx = pairs(jpegs.length);
  if (idx.some(([i, j]) => jpegs[i]!.equals(jpegs[j]!))) return false;
  const near = idx.some(([i, j]) => {
    const a = readings[i]?.thumb;
    const b = readings[j]?.thumb;
    return a && b ? meanAbsDiff(a, b) < NEAR_IDENTICAL_MAD : false;
  });
  return !near;
}

/** True when every frame has an embedding and every pair is the same person (≥ SAME_PERSON_MIN). */
export function framesAgree(readings: FaceReading[], engine: FaceEngine): boolean {
  const embs = readings.map((r) => r.embedding);
  if (embs.some((e) => e === null)) return false;
  return pairs(embs.length).every(
    ([i, j]) => engine.similarity(embs[i]!, embs[j]!) >= SAME_PERSON_MIN,
  );
}
