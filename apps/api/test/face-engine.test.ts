import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { createHumanEngine, MATCH_OPTIONS, type FaceEngine } from '../src/attendance/face/engine';
import { createFakeEngine } from '../src/attendance/face/fake';
import { AppError } from '../src/http/errors';

/** The installed @vladmandic/human package directory (its exports map blocks package.json). */
function humanDir(): string {
  return dirname(dirname(createRequire(import.meta.url).resolve('@vladmandic/human')));
}

function greyJpeg(size = 320): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer();
}

describe('human face engine', () => {
  let engine: FaceEngine;
  beforeAll(() => {
    engine = createHumanEngine();
  });

  it('names its model version', () => expect(engine.modelVersion).toBe('human-3.3.6/faceres'));

  it('finds no face in a blank grey photo', { timeout: 15_000 }, async () => {
    const realFetch = globalThis.fetch;
    const t0 = Date.now();
    const reading = await engine.read(await greyJpeg());
    console.log(`face engine first read (load + detect): ${Date.now() - t0} ms`);
    expect(reading).toMatchObject({ faces: 0, embedding: null });
    expect(globalThis.fetch).toBe(realFetch); // the file:// patch is only in place during load
  });

  it('tells two people apart in real photos', { timeout: 15_000 }, async () => {
    // Faces cropped from the sample sheet shipped inside the library (no network needed).
    const sheet = join(humanDir(), 'assets', 'samples.jpg');
    const crop = (left: number, top: number, width: number, height: number) =>
      sharp(sheet).extract({ left, top, width, height }).jpeg().toBuffer();
    const a = await engine.read(await crop(166, 0, 150, 158));
    const aShifted = await engine.read(await crop(172, 6, 140, 146));
    const b = await engine.read(await crop(360, 0, 170, 158));
    for (const r of [a, aShifted, b]) {
      expect(r.faces).toBe(1);
      expect(r.embedding).toHaveLength(1024);
      expect(r.minFaceWidth).toBeGreaterThan(100);
    }
    const same = engine.similarity(a.embedding!, aShifted.embedding!);
    const different = engine.similarity(a.embedding!, b.embedding!);
    expect(same).toBeGreaterThanOrEqual(0.9);
    expect(different).toBeLessThan(0.6);
  });

  it('rejects bytes that are not an image', { timeout: 15_000 }, async () => {
    const err = await engine.read(Buffer.from('not a jpeg at all')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 400,
      code: 'invalid_image',
      message: 'Could not read the photo. Try again.',
    });
  });

  it('scores a vector as matching itself', () => {
    const x = Array.from({ length: 1024 }, (_, i) => Math.cos(i * 0.37) / 16);
    expect(engine.similarity(x, x)).toBeGreaterThanOrEqual(0.99);
  });

  it('scores unrelated vectors low', () => {
    const x = Array.from({ length: 1024 }, (_, i) => Math.cos(i * 0.37));
    const y = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 1.91));
    expect(engine.similarity(x, y)).toBeLessThan(0.5);
  });

  it("matches Human's own match.similarity with the faceres options", () => {
    const lib = createRequire(import.meta.url)(join(humanDir(), 'dist', 'human.node-wasm.js')) as {
      match: { similarity(a: number[], b: number[], o: object): number };
    };
    const base = Array.from({ length: 1024 }, (_, i) => Math.cos(i * 0.37) * 0.05);
    for (const noise of [0, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1]) {
      const other = base.map((v, i) => v + Math.sin(i * 7.3) * noise);
      expect(engine.similarity(base, other)).toBe(lib.match.similarity(base, other, MATCH_OPTIONS));
    }
  });
});

describe('fake face engine', () => {
  it('returns one face with a fixed embedding by default', async () => {
    const engine = createFakeEngine();
    const r = await engine.read(Buffer.from('anything'));
    expect(r.faces).toBe(1);
    expect(r.embedding).not.toBeNull();
    expect(engine.similarity(r.embedding!, r.embedding!)).toBeGreaterThanOrEqual(0.99);
  });

  it('uses the supplied mapping', async () => {
    const reading = { faces: 2, minFaceWidth: 50, embedding: null, real: 0.1, live: 0.2 };
    const engine = createFakeEngine(() => reading);
    expect(await engine.read(Buffer.alloc(1))).toEqual(reading);
  });
});
