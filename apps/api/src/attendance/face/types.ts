export type FaceReading = {
  /** Number of faces found. */
  faces: number;
  /** Width in pixels of the smallest face, in the photo as sent (only ever scaled down, to fit 640×640); 0 with no face. */
  minFaceWidth: number;
  /** Face descriptor when exactly one face was found, else null. */
  embedding: number[] | null;
  /** Anti-spoof score (0..1), lowest over all faces; 0 with no face. */
  real: number;
  /** Liveness score (0..1), lowest over all faces; 0 with no face. */
  live: number;
};

export interface FaceEngine {
  /** Reads a JPEG; throws AppError(400, 'invalid_image') when it cannot be decoded. */
  read(jpeg: Buffer): Promise<FaceReading>;
  /** Similarity of two descriptors in 0..1 (Human match.similarity, faceres options). */
  similarity(a: number[], b: number[]): number;
  readonly modelVersion: string;
}

/** Match options for the faceres model (from Human's own faceid demo). */
export const MATCH_OPTIONS = { order: 2, multiplier: 25, min: 0.2, max: 0.8 } as const;

/**
 * Port of Human 3.3.6 `match.similarity` (src/face/match.ts) with MATCH_OPTIONS,
 * so scoring needs no loaded models. Euclidean distance, inverted and normalised to 0..1.
 */
export function faceSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  const dist = Math.round(100 * MATCH_OPTIONS.multiplier * sum) / 100;
  if (dist === 0) return 1;
  const norm =
    (1 - Math.sqrt(dist) / 100 - MATCH_OPTIONS.min) / (MATCH_OPTIONS.max - MATCH_OPTIONS.min);
  return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100;
}
