import { createHash } from 'node:crypto';
import { faceSimilarity, type FaceEngine, type FaceReading } from './types';

/** The fake "registered person": a unit-length 1024-value descriptor. */
export const FAKE_EMBEDDING: readonly number[] = Array.from({ length: 1024 }, () => 1 / 32);

/** Per-coordinate jitter: same person (≥ 0.95 similar to FAKE_EMBEDDING), never identical frames. */
const JITTER = 3 / 32;

/** `n` pseudo-random bytes derived from a photo (SHA-256 in counter mode). */
function photoBytes(jpeg: Buffer, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0, block = 0; i < n; block++) {
    const h = createHash('sha256').update(jpeg).update(String(block)).digest();
    for (let j = 0; j < h.length && i < n; j++) out[i++] = h[j]!;
  }
  return out;
}

/**
 * The fake engine's descriptor for a photo: FAKE_EMBEDDING plus ±JITTER per value, the signs
 * taken from the photo bytes. Different photos give the same person; the same photo gives
 * the same descriptor.
 */
export function fakeEmbedding(jpeg: Buffer): number[] {
  const bits = photoBytes(Buffer.concat([Buffer.from('embedding:'), jpeg]), 1024);
  return FAKE_EMBEDDING.map((v, i) => v + (bits[i]! & 1 ? JITTER : -JITTER));
}

/** The fake engine's 32×32 "downscale": bytes derived from the photo, so any change differs. */
export function fakeThumb(jpeg: Buffer): Uint8Array {
  return photoBytes(Buffer.concat([Buffer.from('thumb:'), jpeg]), 1024);
}

/**
 * Face engine without models, for unit and e2e tests (API_FACE_ENGINE=fake). By default every
 * photo is one clear, live face of the same person; `map` overrides the reading per photo
 * (an omitted `thumb` is still derived from the photo).
 */
export function createFakeEngine(
  map?: (jpeg: Buffer) => Omit<FaceReading, 'thumb'> & { thumb?: Uint8Array | null },
): FaceEngine {
  return {
    modelVersion: 'fake',
    read: async (jpeg) => {
      const reading = map
        ? map(jpeg)
        : { faces: 1, minFaceWidth: 320, embedding: fakeEmbedding(jpeg), real: 0.95, live: 0.95 };
      return {
        ...reading,
        embedding: reading.embedding ? [...reading.embedding] : null,
        thumb: reading.thumb === undefined ? fakeThumb(jpeg) : reading.thumb,
      };
    },
    similarity: faceSimilarity,
  };
}
