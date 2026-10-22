import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_MAX_SIDE,
  MIN_CAPTURE_FACE_PX,
  createBlinkTracker,
  createGuide,
  evaluateFrame,
  yawFromGestures,
} from '../src/attendance/face-guide';

const base = { videoW: 1000, videoH: 800, blink: false };
// 400 wide (40%), centred at (500, 400).
const good: [number, number, number, number] = [300, 200, 400, 400];

describe('evaluateFrame', () => {
  it('no-face when no faces', () => {
    expect(evaluateFrame({ ...base, faces: 0 })).toEqual({ kind: 'no-face' });
  });
  it('many-faces when more than one', () => {
    expect(evaluateFrame({ ...base, faces: 2, box: good })).toEqual({ kind: 'many-faces' });
  });
  it('too-far when face is under 30% of video width', () => {
    expect(evaluateFrame({ ...base, faces: 1, box: [400, 300, 200, 200] })).toEqual({
      kind: 'too-far',
    });
  });
  it('too-close when face is over 70% of video width', () => {
    expect(evaluateFrame({ ...base, faces: 1, box: [100, 50, 800, 700] })).toEqual({
      kind: 'too-close',
    });
  });
  it('not-centred horizontally', () => {
    expect(evaluateFrame({ ...base, faces: 1, box: [0, 200, 400, 400] })).toEqual({
      kind: 'not-centred',
    });
  });
  it('not-centred vertically', () => {
    expect(evaluateFrame({ ...base, faces: 1, box: [300, 0, 400, 300] })).toEqual({
      kind: 'not-centred',
    });
  });
  it('ready, not blinked, centre yaw by default', () => {
    expect(evaluateFrame({ ...base, faces: 1, box: good })).toEqual({
      kind: 'ready',
      blinked: false,
      yaw: 'centre',
    });
  });
  it('ready carries the blink latch', () => {
    expect(evaluateFrame({ ...base, faces: 1, box: good, blink: true })).toEqual({
      kind: 'ready',
      blinked: true,
      yaw: 'centre',
    });
  });
  it('ready carries yaw', () => {
    expect(evaluateFrame({ ...base, faces: 1, box: good, yaw: 'left' })).toMatchObject({
      kind: 'ready',
      yaw: 'left',
    });
  });
});

describe('evaluateFrame face size in captured pixels', () => {
  it('captures at most 640 px on the long side and needs a 176 px face', () => {
    expect(CAPTURE_MAX_SIDE).toBe(640);
    expect(MIN_CAPTURE_FACE_PX).toBe(176);
  });
  it('a portrait camera: 35% of 720 px is 126 px once scaled to 640 high, so move closer', () => {
    const portrait = { videoW: 720, videoH: 1280, blink: false, faces: 1 };
    expect(evaluateFrame({ ...portrait, box: [234, 514, 252, 252] })).toEqual({ kind: 'too-far' });
    // 62% of 720 = 446 px → 223 px captured.
    expect(evaluateFrame({ ...portrait, box: [137, 417, 446, 446] })).toMatchObject({
      kind: 'ready',
    });
  });
  it('a small 320×240 camera never scales up: 40% is 128 px, so move closer', () => {
    const small = { videoW: 320, videoH: 240, blink: false, faces: 1 };
    expect(evaluateFrame({ ...small, box: [96, 56, 128, 128] })).toEqual({ kind: 'too-far' });
  });
  it('a landscape 640×480 camera at 30% (192 px) is ready', () => {
    const vga = { videoW: 640, videoH: 480, blink: false, faces: 1 };
    expect(evaluateFrame({ ...vga, box: [224, 144, 192, 192] })).toMatchObject({ kind: 'ready' });
  });
});

describe('fake guide (e2e)', () => {
  afterEach(() => {
    delete window.__SD_FAKE_FACE__;
  });
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  it('captures a different, still valid JPEG every time', async () => {
    window.__SD_FAKE_FACE__ = true;
    const guide = createGuide(document.createElement('video'));
    const shots = [await guide.capture(), await guide.capture(), await guide.capture()];
    expect(new Set(shots).size).toBe(3);
    for (const shot of shots) {
      const b = bytes(shot);
      expect([b[0], b[1], b[2], b[3]]).toEqual([0xff, 0xd8, 0xff, 0xfe]); // SOI, then a COM segment
      expect([b[b.length - 2], b[b.length - 1]]).toEqual([0xff, 0xd9]);
      const len = (b[4]! << 8) | b[5]!;
      expect([b[4 + len], b[5 + len]]).toEqual([0xff, 0xe0]); // the original APP0 follows
    }
  });
});

describe('createBlinkTracker', () => {
  it('latches a blink lasting 10-800 ms', () => {
    const t = createBlinkTracker();
    t.update(true, 1000, true);
    expect(t.blinked).toBe(false);
    t.update(false, 1200, true);
    expect(t.blinked).toBe(true);
  });
  it('ignores blinks under 10 ms', () => {
    const t = createBlinkTracker();
    t.update(true, 1000, true);
    t.update(false, 1005, true);
    expect(t.blinked).toBe(false);
  });
  it('ignores closures over 800 ms', () => {
    const t = createBlinkTracker();
    t.update(true, 1000, true);
    t.update(false, 1900, true);
    expect(t.blinked).toBe(false);
  });
  it('losing the face (not ready) clears the latch', () => {
    const t = createBlinkTracker();
    t.update(true, 1000, true);
    t.update(false, 1200, true);
    t.update(false, 1300, false);
    expect(t.blinked).toBe(false);
  });
  it('a blink while not ready does not count', () => {
    const t = createBlinkTracker();
    t.update(true, 1000, false);
    t.update(false, 1200, true);
    expect(t.blinked).toBe(false);
  });
  it('reset clears the latch', () => {
    const t = createBlinkTracker();
    t.update(true, 1000, true);
    t.update(false, 1200, true);
    t.reset();
    expect(t.blinked).toBe(false);
  });
});

describe('yawFromGestures', () => {
  it('swaps left/right when mirrored (user perspective)', () => {
    expect(yawFromGestures(['facing left'], true)).toBe('right');
    expect(yawFromGestures(['facing right'], true)).toBe('left');
  });
  it('passes through when not mirrored', () => {
    expect(yawFromGestures(['facing left'], false)).toBe('left');
    expect(yawFromGestures(['facing right'], false)).toBe('right');
  });
  it('is centre otherwise', () => {
    expect(yawFromGestures(['blink left eye'], true)).toBe('centre');
  });
});

describe('registration poses', () => {
  it('the approver photo frame is a straight-ahead pose', async () => {
    const { REGISTRATION_PHOTO_FRAME, REGISTRATION_FRAME_COUNT } =
      await import('@sitediary/shared');
    const { FRAME_POSES } = await import('../src/attendance/FaceCapture');
    expect(FRAME_POSES).toHaveLength(REGISTRATION_FRAME_COUNT);
    expect(FRAME_POSES[REGISTRATION_PHOTO_FRAME]).toBe('Look straight at the camera');
  });
});
