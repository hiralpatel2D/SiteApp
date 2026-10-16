import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * Wraps `realFetch` to serve `file://` URLs under one of `allowedDirs` (each a `file://` URL
 * ending in `/`) from disk. Every other URL, including other `file://` paths, goes to `realFetch`.
 */
export function fileFetch(realFetch: typeof fetch, allowedDirs: string[]): typeof fetch {
  const allowed = allowedDirs.map((d) => resolve(fileURLToPath(d)) + sep);
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!raw.startsWith('file:')) return realFetch(input, init);
    // Normalise with path.resolve: Node 22's URL parser leaves `..` after some segments
    // (e.g. `.pnpm`) unresolved, so a URL prefix check alone could be escaped.
    let path: string;
    try {
      path = resolve(fileURLToPath(raw));
    } catch {
      return realFetch(input, init);
    }
    if (!allowed.some((dir) => path.startsWith(dir))) return realFetch(input, init);
    const body = await readFile(path);
    const type = path.endsWith('.json')
      ? 'application/json'
      : path.endsWith('.wasm')
        ? 'application/wasm'
        : 'application/octet-stream';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  };
}

let loads = 0;

/** How many times the models have started loading in this process (for tests). */
export function humanLoadCount(): number {
  return loads;
}

async function loadHuman(): Promise<HumanInstance> {
  loads++;
  const humanDir = packageDir('@vladmandic/human', 2); // <pkg>/dist/human.node.js
  const wasmDir = dirname(require.resolve('@tensorflow/tfjs-backend-wasm')); // <pkg>/dist
  const mod = require(join(humanDir, 'dist', 'human.node-wasm.js')) as {
    default?: HumanConstructor;
    Human?: HumanConstructor;
  };
  const Human = mod.default ?? mod.Human;
  if (!Human) throw new Error('Human library did not export a constructor');
  const wasmUrl = dirUrl(wasmDir);
  const modelsUrl = dirUrl(join(humanDir, 'models'));
  const human = new Human({
    backend: 'wasm',
    wasmPath: wasmUrl,
    modelBasePath: modelsUrl,
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
  globalThis.fetch = fileFetch(realFetch, [wasmUrl, modelsUrl]);
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

/** Largest photo accepted, in pixels (sharp `limitInputPixels`). */
const MAX_INPUT_PIXELS = 4096 * 4096;

/**
 * Decodes a JPEG to raw RGB, honouring EXIF rotation and scaling it down (never up) to fit
 * 640×640. Anything that is not a readable JPEG of at most 4096×4096 pixels is `invalid_image`.
 */
export async function decodeJpeg(jpeg: Buffer): Promise<{ data: Buffer; info: sharp.OutputInfo }> {
  // JPEG magic bytes; checked first so sharp never parses PNG, SVG or other formats.
  if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
    throw invalidImage();
  }
  let decoded: { data: Buffer; info: sharp.OutputInfo };
  try {
    decoded = await sharp(jpeg, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw invalidImage();
  }
  if (decoded.info.channels !== 3) throw invalidImage();
  return decoded;
}

// One model set per process, shared by every engine: loading takes ~300 MB.
let loading: Promise<HumanInstance> | null = null;
// One detection at a time: Human keeps per-instance state and the wasm backend is single-threaded.
let queue: Promise<unknown> = Promise.resolve();

function sharedHuman(): Promise<HumanInstance> {
  loading ??= loadHuman().catch((err: unknown) => {
    loading = null; // let a later read retry
    throw err;
  });
  return loading;
}

async function detect(jpeg: Buffer): Promise<FaceReading> {
  const { data, info } = await decodeJpeg(jpeg);
  const h = await sharedHuman();
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

/**
 * Face engine on @vladmandic/human (wasm backend). Models load on the first read and are
 * shared by all engines in the process; reads run one at a time.
 */
export function createHumanEngine(): FaceEngine {
  return {
    modelVersion: HUMAN_MODEL_VERSION,
    read(jpeg) {
      const run = queue.then(() => detect(jpeg));
      queue = run.catch(() => undefined);
      return run;
    },
    similarity: faceSimilarity,
  };
}
