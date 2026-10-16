import { describe, expect, it } from 'vitest';
import { evaluateFrame } from '../src/attendance/face-guide';

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
