// On-device face guidance for attendance capture. Human (tfjs) is lazy-loaded so it
// stays out of the main bundle. This module only guides the user (count, size,
// centring, blink, yaw); the server decides matches.
import type { Human } from '@vladmandic/human';

/**
 * Head turn from the USER's perspective: 'left' means the person turned to their own
 * left as they see it on a mirrored (selfie) preview. See createGuide's `mirrored`.
 */
export type Yaw = 'left' | 'centre' | 'right';

export type GuideState =
  | { kind: 'no-face' }
  | { kind: 'many-faces' }
  | { kind: 'too-far' }
  | { kind: 'too-close' }
  | { kind: 'not-centred' }
  | { kind: 'ready'; blinked: boolean; yaw: Yaw };

export interface FrameInput {
  faces: number;
  /** Face box in video pixels: [x, y, width, height]. */
  box?: [number, number, number, number];
  videoW: number;
  videoH: number;
  blink: boolean;
  yaw?: Yaw;
}

const MIN_FACE = 0.3;
const MAX_FACE = 0.7;
const CENTRE_BAND = 0.2; // centre must be within 0.5 +/- 0.2 (the middle 40%)
const BLINK_MIN_MS = 10;
const BLINK_MAX_MS = 800;

export function evaluateFrame(f: FrameInput): GuideState {
  if (f.faces === 0 || !f.box) return { kind: 'no-face' };
  if (f.faces > 1) return { kind: 'many-faces' };
  const [x, y, w, h] = f.box;
  const ratio = w / f.videoW;
  if (ratio < MIN_FACE) return { kind: 'too-far' };
  if (ratio > MAX_FACE) return { kind: 'too-close' };
  const cx = (x + w / 2) / f.videoW;
  const cy = (y + h / 2) / f.videoH;
  if (Math.abs(cx - 0.5) > CENTRE_BAND || Math.abs(cy - 0.5) > CENTRE_BAND) {
    return { kind: 'not-centred' };
  }
  return { kind: 'ready', blinked: f.blink, yaw: f.yaw ?? 'centre' };
}

/** Latches a blink (eyes closed 10-800 ms) only while the face is 'ready'. */
export function createBlinkTracker() {
  let closedSince: number | null = null;
  let latched = false;
  return {
    get blinked() {
      return latched;
    },
    update(isClosed: boolean, now: number, ready: boolean) {
      if (!ready) {
        closedSince = null;
        latched = false;
        return;
      }
      if (isClosed) {
        closedSince ??= now;
      } else if (closedSince !== null) {
        const d = now - closedSince;
        if (d >= BLINK_MIN_MS && d <= BLINK_MAX_MS) latched = true;
        closedSince = null;
      }
    },
    reset() {
      closedSince = null;
      latched = false;
    },
  };
}

/** Maps Human's gesture strings to a Yaw; swaps left/right when the preview is mirrored. */
export function yawFromGestures(gestures: string[], mirrored: boolean): Yaw {
  const l = gestures.includes('facing left');
  const r = gestures.includes('facing right');
  if (l === r) return 'centre';
  return l === mirrored ? 'right' : 'left';
}

export interface Guide {
  next(): Promise<GuideState>;
  /** Raw base64 JPEG (no data: prefix). */
  capture(maxSide?: number, quality?: number): Promise<string>;
  /** Forget the blink latch (e.g. when starting a new capture step). */
  resetBlink(): void;
  /** Stops guidance and releases the camera: stops every track of video.srcObject and clears it. */
  stop(): void;
}

declare global {
  interface Window {
    /** e2e only: bypasses the camera and models. */
    __SD_FAKE_FACE__?: boolean | object;
  }
}

// 8x8 grey JPEG, raw base64.
const FAKE_JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooA/9k=';

/**
 * The caller attaches the camera stream to `video`; the guide releases it in stop().
 * `mirrored` (default true) says the preview is shown as a selfie mirror, so Human's
 * left/right are swapped to report yaw from the user's perspective.
 */
export function createGuide(video: HTMLVideoElement, mirrored = true): Guide {
  if (typeof window !== 'undefined' && window.__SD_FAKE_FACE__) {
    return {
      next: async () => ({ kind: 'ready', blinked: true, yaw: 'centre' }),
      capture: async () => FAKE_JPEG,
      resetBlink: () => {},
      stop: () => {},
    };
  }

  let human: Human | undefined;
  let loading: Promise<Human> | undefined;
  let stopped = false;
  const blink = createBlinkTracker();

  function load(): Promise<Human> {
    loading ??= import('@vladmandic/human').then(async (mod) => {
      const h = new mod.Human({
        backend: 'webgl',
        modelBasePath: '/face-models/',
        debug: false,
        cacheSensitivity: 0,
        filter: { enabled: false },
        face: {
          enabled: true,
          detector: { maxDetected: 2, rotation: false },
          mesh: { enabled: true },
          iris: { enabled: true },
          description: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        segmentation: { enabled: false },
        gesture: { enabled: true },
      });
      await h.load();
      await h.warmup();
      return h;
    });
    loading.catch(() => {
      loading = undefined; // allow a retry after a failed load
    });
    return loading;
  }

  return {
    async next() {
      if (stopped) return { kind: 'no-face' };
      human ??= await load();
      const res = await human.detect(video);
      const faces = res.face.length;
      const gestures = res.gesture.map((g) => ('gesture' in g ? String(g.gesture) : ''));
      const box = res.face[0]?.box;
      const input: FrameInput = {
        faces,
        box: box ? [box[0], box[1], box[2], box[3]] : undefined,
        videoW: video.videoWidth,
        videoH: video.videoHeight,
        blink: false,
        yaw: yawFromGestures(gestures, mirrored),
      };
      const state = evaluateFrame(input);
      blink.update(
        gestures.some((g) => g.startsWith('blink')),
        performance.now(),
        state.kind === 'ready',
      );
      return state.kind === 'ready' ? { ...state, blinked: blink.blinked } : state;
    },
    async capture(maxSide = 640, quality = 0.85) {
      if (!video.videoWidth || !video.videoHeight) {
        throw new Error('camera not ready: video has no dimensions');
      }
      const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality).replace(/^data:image\/jpeg;base64,/, '');
    },
    resetBlink: () => blink.reset(),
    stop() {
      stopped = true;
      const stream = video.srcObject;
      if (stream instanceof MediaStream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
