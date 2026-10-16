import { faceSimilarity, type FaceEngine, type FaceReading } from './types';

/** A unit-length 1024-value descriptor that is the same on every call. */
const FAKE_EMBEDDING: number[] = Array.from({ length: 1024 }, () => 1 / 32);

const DEFAULT_READING: FaceReading = {
  faces: 1,
  minFaceWidth: 320,
  embedding: FAKE_EMBEDDING,
  real: 0.95,
  live: 0.95,
};

/** Face engine without models, for unit and e2e tests (API_FACE_ENGINE=fake). */
export function createFakeEngine(map?: (jpeg: Buffer) => FaceReading): FaceEngine {
  return {
    modelVersion: 'fake',
    read: async (jpeg) => {
      const reading = map ? map(jpeg) : DEFAULT_READING;
      return { ...reading, embedding: reading.embedding ? [...reading.embedding] : null };
    },
    similarity: faceSimilarity,
  };
}
