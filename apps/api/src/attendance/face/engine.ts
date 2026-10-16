import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { AppError } from '../../http/errors';
import { faceSimilarity, type FaceEngine, type FaceReading } from './types';

export { faceSimilarity, MATCH_OPTIONS, type FaceEngine, type FaceReading } from './types';

export const HUMAN_MODEL_VERSION = 'human-3.3.6/faceres';

/** The parts of the Human library this engine uses (it ships no usable types for this build). */
type Tensor = { dispose(): void };
type HumanFace = {
  box: [number, number, number, number];
  embedding?: number[];
  real?: number;
  live?: number;
};
type HumanInstance = {
  load(): Promise<void>;
  detect(input: Tensor): Promise<{ face: HumanFace[]; error?: string | null }>;
  tf: { tensor3d(values: Uint8Array, shape: [number, number, number], dtype: 'int32'): Tensor };
};
type HumanConstructor = new (config: Record<string, unknown>) => HumanInstance;

const require = createRequire(import.meta.url);

/**
 * Directory of an installed package. `@vladmandic/human` has a broken `exports` map
 * (it blocks `package.json` and `dist/...` subpaths), so resolve the main entry and walk up.
 */
function packageDir(name: string, entryDepth: number): string {
  let dir = require.resolve(name);
  for (let i = 0; i < entryDepth; i++) dir = dirname(dir);
  return dir;
}

function dirUrl(dir: string): string {
  return pathToFileURL(dir).href + '/';
}

/** Serves `file://` URLs from disk; anything else goes to the real fetch. */
function fileFetch(realFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('file://')) return realFetch(input, init);
    const body = await readFile(new URL(url));
    const type = url.endsWith('.json')
      ? 'application/json'
      : url.endsWith('.wasm')
        ? 'application/wasm'
        : 'application/octet-stream';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  };
}

async function loadHuman(): Promise<HumanInstance> {
  const humanDir = packageDir('@vladmandic/human', 2); // <pkg>/dist/human.node.js
  const wasmDir = dirname(require.resolve('@tensorflow/tfjs-backend-wasm')); // <pkg>/dist
  const mod = require(join(humanDir, 'dist', 'human.node-wasm.js')) as {
    default?: HumanConstructor;
    Human?: HumanConstructor;
  };
  const Human = mod.default ?? mod.Human;
  if (!Human) throw new Error('Human library did not export a constructor');
  const human = new Human({
    backend: 'wasm',
    wasmPath: dirUrl(wasmDir),
    modelBasePath: dirUrl(join(humanDir, 'models')),
    debug: false,
    cacheSensitivity: 0,
    face: {
      enabled: true,
      detector: { rotation: false, maxDetected: 3, skipFrames: 0 },
      mesh: { enabled: true },
      iris: { enabled: false },
      description: { enabled: true },
      emotion: { enabled: false },
      antispoof: { enabled: true },
      liveness: { enabled: true },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
    segmentation: { enabled: false },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fileFetch(realFetch);
  try {
    await human.load();
  } finally {
    globalThis.fetch = realFetch;
  }
  return human;
}

function invalidImage(): AppError {
  return new AppError(400, 'invalid_image', 'Could not read the photo. Try again.');
}

/** Face engine on @vladmandic/human (wasm backend). Models load on the first read. */
export function createHumanEngine(): FaceEngine {
  let loading: Promise<HumanInstance> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function human(): Promise<HumanInstance> {
    loading ??= loadHuman().catch((err: unknown) => {
      loading = null; // let a later read retry
      throw err;
    });
    return loading;
  }

  async function detect(jpeg: Buffer): Promise<FaceReading> {
    let decoded: { data: Buffer; info: sharp.OutputInfo };
    try {
      decoded = await sharp(jpeg)
        .rotate()
        .resize({ width: 640, height: 640, fit: 'inside' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw invalidImage();
    }
    const { data, info } = decoded;
    if (info.channels !== 3) throw invalidImage();
    const h = await human();
    const tensor = h.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    let result: Awaited<ReturnType<HumanInstance['detect']>>;
    try {
      result = await h.detect(tensor);
    } finally {
      tensor.dispose();
    }
    if (result.error) throw new Error(`Face detection failed: ${result.error}`);
    const faces = result.face;
    if (faces.length === 0) return { faces: 0, minFaceWidth: 0, embedding: null, real: 0, live: 0 };
    const only = faces.length === 1 ? faces[0] : undefined;
    return {
      faces: faces.length,
      minFaceWidth: Math.min(...faces.map((f) => f.box[2])),
      embedding: only?.embedding?.length ? Array.from(only.embedding) : null,
      real: Math.min(...faces.map((f) => f.real ?? 0)),
      live: Math.min(...faces.map((f) => f.live ?? 0)),
    };
  }

  return {
    modelVersion: HUMAN_MODEL_VERSION,
    // One detection at a time: Human keeps per-instance state and the wasm backend is single-threaded.
    read(jpeg) {
      const run = queue.then(() => detect(jpeg));
      queue = run.catch(() => undefined);
      return run;
    },
    similarity: faceSimilarity,
  };
}
