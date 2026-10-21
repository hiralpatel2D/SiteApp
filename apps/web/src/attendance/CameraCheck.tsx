import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, errorMessage } from '../lib/api';
import { matchFace } from '../lib/attendance';
import { secondaryButton } from '../components/ui';
import { createGuide, type Guide, type GuideState } from './face-guide';

export const CAMERA_BLOCKED =
  'Camera is blocked. Allow camera for this site in your browser settings.';
const CAMERA_FAILED = 'The camera could not start. Close other apps using it and try again.';
const NOT_RECOGNISED = 'Face not recognised. Try again in better light.';
const GUIDE_FAILED = 'The face check could not start. Check your connection and try again.';
/** Consecutive guide.next() failures before giving up (models failed to load, etc.). */
const MAX_GUIDE_FAILURES = 20;

const HOLD_MS = 3000;
const TICK_MS = 100;
/** /match is limited to 30 a minute; never ask more often than this. */
const MATCH_GAP_MS = 2000;
const FRAME_GAP_MS = 250;
const FRAMES = 3;

const PROMPTS: Record<Exclude<GuideState['kind'], 'ready'>, string> = {
  'no-face': 'Look at the camera',
  'many-faces': 'Only one person in the frame',
  'too-far': 'Move closer',
  'too-close': 'Move back a little',
  'not-centred': 'Centre your face',
};

function promptFor(s: GuideState): string {
  if (s.kind !== 'ready') return PROMPTS[s.kind];
  return s.blinked ? 'Checking your face…' : 'Blink once';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
      } catch (err) {
        if (!live) return;
        const name = err instanceof DOMException ? err.name : '';
        cb.current.onError(
          name === 'NotAllowedError' || name === 'SecurityError' ? CAMERA_BLOCKED : CAMERA_FAILED,
        );
        return;
      }
      const video = videoRef.current;
      if (!live || !video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay of a muted inline video is allowed; ignore odd browsers.
      }
      if (!live) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
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
      <div className="relative mx-auto aspect-[3/4] w-full max-w-[420px] overflow-hidden rounded-[var(--r)] border border-line bg-surface">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label="Camera preview"
          className="size-full -scale-x-100 object-cover"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-[62%] w-[56%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-4 border-dashed border-white/80"
        />
      </div>
      <p
        role="status"
        aria-live="polite"
        className="text-center font-display text-[26px] font-extrabold uppercase leading-tight"
      >
        {prompt}
      </p>
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
