import type { FaceEngine, FaceReading } from './types';

/**
 * Two frames whose 32×32 greyscale downscales differ by less than this mean absolute
 * difference (on 0..255) are near-identical: a replayed photo, not a live person. Live
 * selfies differ by well over this between frames (hand shake, blinking, head turn,
 * sensor noise); a re-encoded copy of one photo differs by well under 1.
 */
export const NEAR_IDENTICAL_MAD = 2.0;

/** Every pair of embeddings at least this similar means the frames are one photo replayed. */
export const IDENTICAL_EMBEDDING_MIN = 0.999;

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
 * False when the frames look replayed: any two byte-identical, any two near-identical
 * (downscale MAD < NEAR_IDENTICAL_MAD), or every pair of embeddings ≥ IDENTICAL_EMBEDDING_MIN.
 */
export function framesDistinct(
  jpegs: Buffer[],
  readings: FaceReading[],
  engine: FaceEngine,
): boolean {
  const idx = pairs(jpegs.length);
  if (idx.some(([i, j]) => jpegs[i]!.equals(jpegs[j]!))) return false;
  const near = idx.some(([i, j]) => {
    const a = readings[i]?.thumb;
    const b = readings[j]?.thumb;
    return a && b ? meanAbsDiff(a, b) < NEAR_IDENTICAL_MAD : false;
  });
  if (near) return false;
  const embs = readings.map((r) => r.embedding);
  if (embs.length >= 2 && embs.every((e) => e !== null)) {
    const same = pairs(embs.length).every(
      ([i, j]) => engine.similarity(embs[i]!, embs[j]!) >= IDENTICAL_EMBEDDING_MIN,
    );
    if (same) return false;
  }
  return true;
}

/** True when every frame has an embedding and every pair is the same person (≥ SAME_PERSON_MIN). */
export function framesAgree(readings: FaceReading[], engine: FaceEngine): boolean {
  const embs = readings.map((r) => r.embedding);
  if (embs.some((e) => e === null)) return false;
  return pairs(embs.length).every(
    ([i, j]) => engine.similarity(embs[i]!, embs[j]!) >= SAME_PERSON_MIN,
  );
}
