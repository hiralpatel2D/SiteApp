import { useEffect, useRef, useState } from 'react';
import { REGISTRATION_FRAME_COUNT, REGISTRATION_PHOTO_FRAME } from '@sitediary/shared';
import { secondaryButton } from '../components/ui';
import { createGuide, type Guide, type GuideState } from './face-guide';
import {
  CameraError,
  CameraPreview,
  CameraPrompt,
  CAMERA_FAILED,
  FRAME_GAP_MS,
  GUIDE_FAILED,
  GUIDE_PROMPTS,
  MAX_GUIDE_FAILURES,
  TICK_MS,
  sleep,
  startCamera,
} from './camera';

type Ready = Extract<GuideState, { kind: 'ready' }>;

const STRAIGHT_PROMPT = 'Look straight at the camera';

/** The poses, in order, and how many frames each gives (5 in all). */
const POSES: { prompt: string; ok: (s: Ready) => boolean; frames: number }[] = [
  { prompt: 'Blink once', ok: (s) => s.blinked, frames: 1 },
  { prompt: 'Turn your head left', ok: (s) => s.yaw === 'left', frames: 1 },
  { prompt: 'Turn your head right', ok: (s) => s.yaw === 'right', frames: 1 },
  { prompt: STRAIGHT_PROMPT, ok: (s) => s.yaw === 'centre', frames: 2 },
];

/** The pose prompt of each frame sent, in order. */
export const FRAME_POSES: readonly string[] = POSES.flatMap((p) =>
  Array.from({ length: p.frames }, () => p.prompt),
);

if (FRAME_POSES.length !== REGISTRATION_FRAME_COUNT) {
  throw new Error('POSES must add up to REGISTRATION_FRAME_COUNT frames');
}
// The server keeps frame REGISTRATION_PHOTO_FRAME for the approver: it must face the camera.
if (FRAME_POSES[REGISTRATION_PHOTO_FRAME] !== STRAIGHT_PROMPT) {
  throw new Error('REGISTRATION_PHOTO_FRAME must be a straight-ahead frame');
}

type Props = {
  /** Called once with the raw base64 JPEG frames. The camera is already off. */
  onCaptured: (frames: string[]) => void;
  /** The camera or the face guide could not start (message to show). */
  onError: (message: string) => void;
  onCancel: () => void;
};

/**
 * Selfie camera for face registration: blink, turn left, turn right, look straight,
 * taking frames at each pose. The camera is released on every exit.
 */
export function FaceCapture({ onCaptured, onError, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [prompt, setPrompt] = useState('Starting the camera…');
  const [taken, setTaken] = useState(0);
  // Latest callbacks without restarting the camera when the parent re-renders.
  const cb = useRef({ onCaptured, onError });
  useEffect(() => {
    cb.current = { onCaptured, onError };
  });

  useEffect(() => {
    let live = true;
    let guide: Guide | null = null;

    async function run() {
      let stream: MediaStream | null;
      try {
        stream = await startCamera(videoRef.current, () => live);
      } catch (err) {
        if (live) cb.current.onError(err instanceof CameraError ? err.message : CAMERA_FAILED);
        return;
      }
      const video = videoRef.current;
      if (!stream || !video) return;
      guide = createGuide(video);
      guide.resetBlink();
      const frames: string[] = [];
      let pose = 0;
      let failures = 0;

      while (live && pose < POSES.length) {
        const want = POSES[pose]!;
        let state: GuideState;
        try {
          state = await guide.next();
          failures = 0;
        } catch {
          if (!live) return;
          if (++failures >= MAX_GUIDE_FAILURES) {
            live = false;
            guide.stop();
            cb.current.onError(GUIDE_FAILED);
            return;
          }
          state = { kind: 'no-face' };
        }
        if (!live) return;

        if (state.kind !== 'ready') {
          setPrompt(GUIDE_PROMPTS[state.kind]);
        } else {
          setPrompt(want.prompt);
          if (want.ok(state)) {
            const got: string[] = [];
            try {
              for (let i = 0; i < want.frames; i++) {
                if (i > 0) await sleep(FRAME_GAP_MS);
                if (!live) return;
                got.push(await guide.capture());
              }
            } catch {
              // Camera not ready yet: retake this pose on the next tick.
            }
            if (!live) return;
            if (got.length === want.frames) {
              frames.push(...got);
              setTaken(frames.length);
              pose++;
              if (pose < POSES.length) setPrompt(POSES[pose]!.prompt);
            }
          }
        }
        await sleep(TICK_MS);
      }
      if (!live) return;
      live = false;
      guide.stop();
      cb.current.onCaptured(frames);
    }

    void run();
    return () => {
      live = false;
      // Releases the camera; startCamera releases it itself if we stop before it returns.
      guide?.stop();
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <CameraPreview videoRef={videoRef} />
      <CameraPrompt>{prompt}</CameraPrompt>
      <p className="text-center font-mono text-[12px] uppercase tracking-widest text-muted">
        {`Photo ${Math.min(taken + 1, REGISTRATION_FRAME_COUNT)} of ${REGISTRATION_FRAME_COUNT}`}
      </p>
      <button type="button" className={secondaryButton} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
