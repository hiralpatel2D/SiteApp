import type { RefObject } from 'react';
import type { GuideState } from './face-guide';

// Camera pieces shared by the check-in camera and face registration.

export const CAMERA_BLOCKED =
  'Camera is blocked. Allow camera for this site in your browser settings.';
export const CAMERA_FAILED = 'The camera could not start. Close other apps using it and try again.';
export const GUIDE_FAILED = 'The face check could not start. Check your connection and try again.';
/** Consecutive guide.next() failures before giving up (models failed to load, etc.). */
export const MAX_GUIDE_FAILURES = 20;
export const TICK_MS = 100;
export const FRAME_GAP_MS = 250;

export const GUIDE_PROMPTS: Record<Exclude<GuideState['kind'], 'ready'>, string> = {
  'no-face': 'Look at the camera',
  'many-faces': 'Only one person in the frame',
  'too-far': 'Move closer',
  'too-close': 'Move back a little',
  'not-centred': 'Centre your face',
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A camera failure carrying the message to show. */
export class CameraError extends Error {}

/**
 * Opens the selfie camera into `video`. Returns null (with the camera released) when
 * `live()` turned false meanwhile; throws CameraError with the message to show.
 */
export async function startCamera(
  video: HTMLVideoElement | null,
  live: () => boolean,
): Promise<MediaStream | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: false,
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    throw new CameraError(
      name === 'NotAllowedError' || name === 'SecurityError' ? CAMERA_BLOCKED : CAMERA_FAILED,
    );
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  if (!live() || !video) {
    release();
    return null;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // Autoplay of a muted inline video is allowed; ignore odd browsers.
  }
  if (!live()) {
    release();
    return null;
  }
  return stream;
}

/** Mirrored selfie preview with the face oval. */
export function CameraPreview({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  return (
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
  );
}

/** The large spoken-style prompt under the preview. */
export function CameraPrompt({ children }: { children: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-center font-display text-[26px] font-extrabold uppercase leading-tight"
    >
      {children}
    </p>
  );
}
