import { describe, it, expect } from 'vitest';
import { createFakeEngine, FAKE_EMBEDDING, fakeEmbedding } from '../src/attendance/face/fake';
import {
  NEAR_IDENTICAL_MAD,
  framesAgree,
  framesDistinct,
  meanAbsDiff,
} from '../src/attendance/face/frames';
import { faceSimilarity, type FaceReading } from '../src/attendance/face/types';

const thumb = (v: number) => new Uint8Array(1024).fill(v);
const reading = (over: Partial<FaceReading> = {}): FaceReading => ({
  faces: 1,
  minFaceWidth: 320,
  embedding: fakeEmbedding(Buffer.from([Math.random() * 255])),
  real: 0.95,
  live: 0.95,
  thumb: thumb(0),
  ...over,
});
const engine = createFakeEngine();
const jpegs = (...bytes: number[]) => bytes.map((b) => Buffer.from([b, b, b]));

describe('meanAbsDiff', () => {
  it('is the mean absolute difference on 0..255', () => {
    expect(meanAbsDiff(thumb(10), thumb(10))).toBe(0);
    expect(meanAbsDiff(thumb(10), thumb(13))).toBe(3);
    const a = thumb(0);
    a[0] = 255;
    expect(meanAbsDiff(a, thumb(0))).toBeCloseTo(255 / 1024);
  });
  it('treats different sizes as fully different', () =>
    expect(meanAbsDiff(new Uint8Array(4), thumb(0))).toBe(255));
});

describe('framesDistinct (replay check)', () => {
  const embs = [1, 2, 3].map((n) => fakeEmbedding(Buffer.from([n])));
  const ok = [0, 1, 2].map((i) => reading({ thumb: thumb(i * 10), embedding: embs[i]! }));

  it('passes distinct frames', () => expect(framesDistinct(jpegs(1, 2, 3), ok)).toBe(true));

  it('fails when two frames are byte-identical', () =>
    expect(framesDistinct(jpegs(1, 1, 3), ok)).toBe(false));

  it(`fails when two downscaled frames differ by less than ${NEAR_IDENTICAL_MAD} on average`, () => {
    expect(NEAR_IDENTICAL_MAD).toBe(1);
    // Every other pixel one level brighter than frame 0: MAD 0.5.
    const half = Uint8Array.from({ length: 1024 }, (_, i) => i % 2);
    const near = [ok[0]!, { ...ok[1]!, thumb: half }, ok[2]!];
    expect(framesDistinct(jpegs(1, 2, 3), near)).toBe(false);
    // MAD exactly 1.0 (a 1 px hand shake measures 1.3-2.0) is not flagged.
    const apart = [ok[0]!, { ...ok[1]!, thumb: thumb(1) }, ok[2]!];
    expect(framesDistinct(jpegs(1, 2, 3), apart)).toBe(true);
  });

  it('does not flag different images whose embeddings are (near) identical', () => {
    // Real same-person frames 250 ms apart often score 1.00 (the similarity saturates).
    const same = ok.map((r) => ({ ...r, embedding: [...FAKE_EMBEDDING] }));
    expect(framesDistinct(jpegs(1, 2, 3), same)).toBe(true);
  });
});

describe('framesAgree (same person)', () => {
  const embs = [1, 2, 3].map((n) => fakeEmbedding(Buffer.from([n])));
  it('passes frames of the same person', () =>
    expect(
      framesAgree(
        embs.map((embedding) => reading({ embedding })),
        engine,
      ),
    ).toBe(true));
  it('fails when one frame is someone else', () => {
    const stranger = Array.from({ length: 1024 }, () => -1);
    expect(
      framesAgree(
        [reading({ embedding: embs[0]! }), reading({ embedding: stranger }), reading()],
        engine,
      ),
    ).toBe(false);
  });
  it('fails closed when a frame has no embedding', () =>
    expect(framesAgree([reading(), reading({ embedding: null })], engine)).toBe(false));
});

describe('fake engine readings', () => {
  it('jitters the embedding per photo: same person, never identical', async () => {
    const reads = await Promise.all(jpegs(1, 2, 3, 4, 5).map((j) => engine.read(j)));
    for (const r of reads) {
      expect(faceSimilarity(r.embedding!, [...FAKE_EMBEDDING])).toBeGreaterThanOrEqual(0.95);
    }
    for (let i = 0; i < reads.length; i++) {
      for (let j = i + 1; j < reads.length; j++) {
        const s = faceSimilarity(reads[i]!.embedding!, reads[j]!.embedding!);
        expect(s).toBeGreaterThanOrEqual(0.95);
        expect(s).toBeLessThan(0.999);
        expect(meanAbsDiff(reads[i]!.thumb!, reads[j]!.thumb!)).toBeGreaterThan(NEAR_IDENTICAL_MAD);
      }
    }
    expect(framesDistinct(jpegs(1, 2, 3), reads.slice(0, 3))).toBe(true);
    expect(framesAgree(reads, engine)).toBe(true);
  });

  it('reads the same photo the same way', async () => {
    const [a, b] = await Promise.all(jpegs(7, 7).map((j) => engine.read(j)));
    expect(a).toEqual(b);
  });
});
