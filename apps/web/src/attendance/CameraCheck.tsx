import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, errorMessage } from '../lib/api';
import { matchFace } from '../lib/attendance';
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

const NOT_RECOGNISED = 'Face not recognised. Try again in better light.';

const HOLD_MS = 3000;
/** /match is limited to 30 a minute; never ask more often than this. */
const MATCH_GAP_MS = 2000;
const FRAMES = 3;

function promptFor(s: GuideState): string {
  if (s.kind !== 'ready') return GUIDE_PROMPTS[s.kind];
  return s.blinked ? 'Checking your face…' : 'Blink once';
}

type Props = {
  /** Called once with 3 raw base64 JPEG frames after a matched 3-second hold. The camera is already off. */
  onCaptured: (frames: string[]) => void;
  /** The camera could not open (message to show). */
  onError: (message: string) => void;
  onCancel: () => void;
};

/**
 * Selfie camera with on-device guidance. When the face is ready and has blinked it
 * asks the server for a match; a match turns the whole screen green for a 3-second
 * hold, then 3 frames are taken. Losing the face during the hold starts over.
 */
export function CameraCheck({ onCaptured, onError, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [prompt, setPrompt] = useState('Starting the camera…');
  const [notice, setNotice] = useState('');
  const [hold, setHold] = useState<number | null>(null);
  // Latest callbacks without restarting the camera when the parent re-renders.
  const cb = useRef({ onCaptured, onError });
  cb.current = { onCaptured, onError };

  useEffect(() => {
    let live = true;
    let guide: Guide | null = null;
    let stream: MediaStream | null = null;

    async function run() {
      try {
        stream = await startCamera(videoRef.current, () => live);
      } catch (err) {
        if (!live) return;
        cb.current.onError(err instanceof CameraError ? err.message : CAMERA_FAILED);
        return;
      }
      const video = videoRef.current;
      if (!stream || !video) return;
      guide = createGuide(video);
      let lastMatch = -Infinity;
      let holdStart: number | null = null;
      let failures = 0;

      const cancelHold = () => {
        holdStart = null;
        setHold(null);
        guide!.resetBlink();
      };

      while (live) {
        let state: GuideState;
        try {
          state = await guide.next();
          failures = 0;
        } catch {
          if (!live) return;
          if (++failures >= MAX_GUIDE_FAILURES) {
            live = false;
            guide.stop();
            setHold(null);
            cb.current.onError(GUIDE_FAILED);
            return;
          }
          state = { kind: 'no-face' };
        }
        if (!live) return;

        if (holdStart !== null) {
          if (state.kind !== 'ready') {
            cancelHold();
            setPrompt(promptFor(state));
          } else {
            const elapsed = Date.now() - holdStart;
            if (elapsed >= HOLD_MS) {
              const frames: string[] = [];
              try {
                for (let i = 0; i < FRAMES; i++) {
                  if (i > 0) await sleep(FRAME_GAP_MS);
                  if (!live) return;
                  frames.push(await guide.capture());
                }
              } catch {
                cancelHold();
                continue;
              }
              if (!live) return;
              live = false;
              guide.stop();
              setHold(null);
              cb.current.onCaptured(frames);
              return;
            }
            setHold(Math.max(1, Math.ceil((HOLD_MS - elapsed) / 1000)));
          }
        } else {
          setPrompt(promptFor(state));
          if (state.kind === 'ready' && state.blinked && Date.now() - lastMatch >= MATCH_GAP_MS) {
            let frame: string | null = null;
            try {
              frame = await guide.capture();
            } catch {
              // Camera not ready yet: try again on the next tick, without using the 2 s gate.
            }
            if (!live) return;
            if (frame === null) {
              await sleep(TICK_MS);
              continue;
            }
            lastMatch = Date.now();
            let matched = false;
            try {
              matched = (await matchFace(frame)).matched;
              if (!matched) setNotice(NOT_RECOGNISED);
            } catch (err) {
              setNotice(err instanceof ApiError ? errorMessage(err) : NOT_RECOGNISED);
            }
            if (!live) return;
            if (matched) {
              setNotice('');
              holdStart = Date.now();
              setHold(3);
            } else {
              guide.resetBlink();
            }
          }
        }
        await sleep(TICK_MS);
      }
    }

    void run();
    return () => {
      live = false;
      if (guide) guide.stop();
      else stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <CameraPreview videoRef={videoRef} />
      <CameraPrompt>{prompt}</CameraPrompt>
      {notice && (
        <p role="alert" className="text-center font-medium">
          {notice}
        </p>
      )}
      <button type="button" className={secondaryButton} onClick={onCancel}>
        Cancel
      </button>
      {hold !== null && <HoldScreen count={hold} />}
    </div>
  );
}

/** Whole-screen green while the person holds still. The number stays under reduced motion. */
function HoldScreen({ count }: { count: number }) {
  return createPortal(
    <div
      role="status"
      aria-live="assertive"
      className="fixed inset-0 z-50 grid place-items-center bg-good px-6 text-center text-bg"
    >
      <p
        key={count}
        className="font-display text-[44px] font-extrabold uppercase leading-none motion-safe:animate-[rise_.4s_var(--ease-out)_both] sm:text-[64px]"
      >
        {`Hold still… ${count}`}
      </p>
    </div>,
    document.body,
  );
}
