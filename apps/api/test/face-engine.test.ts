import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
  createHumanEngine,
  decodeJpeg,
  fileFetch,
  humanLoadCount,
  MATCH_OPTIONS,
  type FaceEngine,
} from '../src/attendance/face/engine';
import { createFakeEngine } from '../src/attendance/face/fake';
import { meanAbsDiff, NEAR_IDENTICAL_MAD } from '../src/attendance/face/frames';
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

  it(
    'gives every photo a 32×32 greyscale thumb for the replay check',
    { timeout: 15_000 },
    async () => {
      const grey = await engine.read(await greyJpeg(200));
      expect(grey.thumb).toHaveLength(1024);
      expect(Math.abs(grey.thumb![0]! - 128)).toBeLessThan(4);
      const dark = await engine.read(
        await sharp({
          create: { width: 300, height: 200, channels: 3, background: { r: 20, g: 20, b: 20 } },
        })
          .jpeg()
          .toBuffer(),
      );
      expect(dark.thumb).toHaveLength(1024);
      expect(meanAbsDiff(grey.thumb!, dark.thumb!)).toBeGreaterThan(50);
      // The same picture re-encoded is near-identical.
      const again = await engine.read(await greyJpeg(260));
      expect(meanAbsDiff(grey.thumb!, again.thumb!)).toBeLessThan(NEAR_IDENTICAL_MAD);
    },
  );

  it('rejects bytes that are not an image', { timeout: 15_000 }, async () => {
    const err = await engine.read(Buffer.from('not a jpeg at all')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 400,
      code: 'invalid_image',
      message: 'Could not read the photo. Try again.',
    });
  });

  async function expectInvalidImage(bytes: Buffer): Promise<void> {
    const err = await engine.read(bytes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_image' });
  }

  it('rejects a valid PNG', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    await expectInvalidImage(png);
  });

  it('rejects an SVG', () =>
    expectInvalidImage(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>',
      ),
    ));

  it('rejects a JPEG larger than 4096×4096 pixels', { timeout: 15_000 }, async () =>
    expectInvalidImage(
      await sharp({
        create: { width: 4097, height: 4096, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .jpeg()
        .toBuffer(),
    ),
  );

  it('shares one loaded model set between engines', { timeout: 15_000 }, async () => {
    const other = createHumanEngine();
    await Promise.all([engine.read(await greyJpeg(100)), other.read(await greyJpeg(120))]);
    expect(humanLoadCount()).toBe(1);
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

describe('decodeJpeg', () => {
  it('does not enlarge a small photo', async () => {
    const { info } = await decodeJpeg(await greyJpeg(200));
    expect([info.width, info.height, info.channels]).toEqual([200, 200, 3]);
  });

  it('scales a large photo down to fit 640×640', async () => {
    const big = await sharp({
      create: { width: 1280, height: 960, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer();
    const { info } = await decodeJpeg(big);
    expect([info.width, info.height]).toEqual([640, 480]);
  });
});

describe('fileFetch (model loading)', () => {
  const dir = dirname(createRequire(import.meta.url).resolve('@vladmandic/human'));
  const allowed = pathToFileURL(dir).href + '/';
  const delegated = vi.fn(async () => new Response('real'));
  const patched = fileFetch(delegated as unknown as typeof fetch, [allowed]);

  it('serves files under an allowed directory from disk', async () => {
    const res = await patched(allowed + 'human.node-wasm.js');
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(1000);
    expect(delegated).not.toHaveBeenCalled();
  });

  it('delegates other file:// URLs and web URLs to the original fetch', async () => {
    expect(await (await patched('file:///etc/hostname')).text()).toBe('real');
    expect(await (await patched(allowed + '../../../../../../etc/hostname')).text()).toBe('real');
    expect(await (await patched('https://example.test/x')).text()).toBe('real');
    expect(delegated).toHaveBeenCalledTimes(3);
  });
});

describe('fake face engine', () => {
  it('returns one clear face of the fake person by default', async () => {
    const engine = createFakeEngine();
    const r = await engine.read(Buffer.from('anything'));
    expect(r.faces).toBe(1);
    expect(r.embedding).not.toBeNull();
    expect(engine.similarity(r.embedding!, r.embedding!)).toBeGreaterThanOrEqual(0.99);
  });

  it('uses the supplied mapping', async () => {
    const reading = { faces: 2, minFaceWidth: 50, embedding: null, real: 0.1, live: 0.2 };
    const engine = createFakeEngine(() => ({ ...reading, thumb: null }));
    expect(await engine.read(Buffer.alloc(1))).toEqual({ ...reading, thumb: null });
  });
});
