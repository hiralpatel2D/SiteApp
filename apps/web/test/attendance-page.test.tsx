import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { GuideState } from '../src/attendance/face-guide';
import { routeTree } from '../src/routeTree.gen';
import { setActiveCompany } from '../src/lib/company';
import { setActiveProject } from '../src/lib/project';

const guide = vi.hoisted(() => ({
  state: { kind: 'ready', blinked: true, yaw: 'centre' } as GuideState,
  next: vi.fn(),
  capture: vi.fn(),
  resetBlink: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../src/attendance/face-guide', () => ({
  createGuide: () => ({
    next: guide.next,
    capture: guide.capture,
    resetBlink: guide.resetBlink,
    stop: guide.stop,
  }),
}));

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-16T03:22:00.000Z';
const SITE = { lat: 18.5204, lng: 73.8567 };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const me = {
  user: {
    id: 'u1',
    name: 'Hiral Patel',
    email: 'o@x.test',
    isPlatformAdmin: false,
    mustChangePassword: false,
  },
  memberships: [
    {
      companyId: COMPANY_ID,
      companyName: 'V and P',
      companySlug: 'vp',
      companyStatus: 'active',
      roleName: 'Site Engineer',
      status: 'active',
    },
  ],
};

type Today = {
  setUp: boolean;
  face: string;
  checkIn: unknown;
  checkOut: unknown;
};

const today = (over: Partial<Today> = {}): Today => ({
  setUp: true,
  face: 'approved',
  checkIn: null,
  checkOut: null,
  ...over,
});

function setup(opts: { today?: Today; check?: () => Response } = {}) {
  const posted: Record<string, unknown> = {};
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/me')) return Promise.resolve(json(200, me));
    if (url.includes('/api/company/context'))
      return Promise.resolve(
        json(200, {
          company: { id: COMPANY_ID, name: 'V and P', slug: 'vp' },
          role: { id: 'r1', name: 'Site Engineer', key: null },
          capabilities: ['projects.view', 'attendance.view'],
        }),
      );
    if (url.includes('/api/projects'))
      return Promise.resolve(
        json(200, [
          {
            id: P1,
            name: 'Riverside Tower',
            code: 'RT-P2',
            location: 'Pune',
            status: 'active',
            memberCount: 3,
            version: 1,
          },
        ]),
      );
    if (url.includes('/api/attendance/today')) {
      posted.todayLoads = ((posted.todayLoads as number | undefined) ?? 0) + 1;
      return Promise.resolve(json(200, opts.today ?? today()));
    }
    if (url.includes('/api/attendance/settings/'))
      return Promise.resolve(
        json(200, {
          settings:
            opts.today?.setUp === false
              ? null
              : {
                  ...SITE,
                  radiusM: 100,
                  startTime: '09:00',
                  lateAfterMin: 15,
                  reminderTime: '19:00',
                  timezone: 'Asia/Kolkata',
                  version: 1,
                },
        }),
      );
    if (url.includes('/api/attendance/match')) {
      posted.match = JSON.parse(String(init?.body));
      return Promise.resolve(json(200, { matched: true, similarity: 0.82 }));
    }
    if (url.includes('/api/attendance/check')) {
      posted.check = JSON.parse(String(init?.body));
      return Promise.resolve(opts.check ? opts.check() : json(500, {}));
    }
    return Promise.resolve(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return posted;
}

const track = { stop: vi.fn() };
const stream = { getTracks: () => [track] };

function stubDevices(
  camera: () => Promise<unknown> = () => Promise.resolve(stream),
  answers = true,
) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: PositionCallback) =>
        answers &&
        ok({
          coords: { latitude: SITE.lat + 0.0003, longitude: SITE.lng, accuracy: 8 },
          timestamp: Date.now(),
        } as GeolocationPosition),
    },
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(camera) },
  });
}

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const checkedIn = {
  id: 'e1',
  kind: 'check_in',
  status: 'recorded',
  reasons: [],
  at: AT,
  workDate: '2026-10-16',
  distanceM: 42.3,
  lateMin: 12,
  projectName: 'Riverside Tower',
};

/** Clicks Check in and waits for the green screen (fake timers must be on). */
async function reachHold() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  renderAt('/attendance');
  await user.click(await screen.findByRole('button', { name: 'Check in' }));
  expect(await screen.findByText('Hold still… 3')).toBeTruthy();
  return user;
}

describe('Attendance page', () => {
  beforeEach(() => {
    setActiveCompany(COMPANY_ID);
    setActiveProject(COMPANY_ID, P1);
    guide.state = { kind: 'ready', blinked: true, yaw: 'centre' };
    guide.next.mockReset().mockImplementation(async () => guide.state);
    guide.capture.mockReset().mockResolvedValue('AAAA');
    guide.resetBlink.mockReset();
    guide.stop.mockReset();
    track.stop.mockReset();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    stubDevices();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setActiveCompany(null);
    setActiveProject(COMPANY_ID, null);
  });

  it('shows Check in when nothing is marked', async () => {
    setup();
    renderAt('/attendance');
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeTruthy();
    expect(screen.getByText('Riverside Tower')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check out' })).toBeNull();
  });

  it('green screen then confirmation with time and distance', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const posted = setup({ check: () => json(200, checkedIn) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt('/attendance');
    await user.click(await screen.findByRole('button', { name: 'Check in' }));

    expect(await screen.findByText(/33 m from site · ±8 m/)).toBeTruthy();
    expect(await screen.findByText('Hold still… 3')).toBeTruthy();
    expect(posted.match).toEqual({ frame: 'AAAA' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(
      await screen.findByText('Checked in at 08:52 · Riverside Tower · 42 m from site'),
    ).toBeTruthy();
    expect(screen.getByText('Late by 12 min')).toBeTruthy();
    expect(screen.queryByText(/Hold still/)).toBeNull();
    const check = posted.check as { kind: string; frames: string[]; projectId: string };
    expect(check.kind).toBe('check_in');
    expect(check.projectId).toBe(P1);
    expect(check.frames).toHaveLength(3);
    expect(guide.stop).toHaveBeenCalled();

    // Today updates from the result: the next action is Check out, without a reload.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Check out' })).toBeTruthy();
    expect(screen.getByText('Checked in at 08:52')).toBeTruthy();
    expect(posted.todayLoads).toBe(1);
  });

  it('pending confirmation lists reasons', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup({
      today: today({
        checkIn: { status: 'recorded', at: AT, distanceM: 20, lateMin: 0, reasons: [] },
      }),
      check: () =>
        json(200, {
          id: 'e2',
          kind: 'check_out',
          status: 'pending',
          reasons: [
            'Outside site radius (240 m, allowed 100 m)',
            'Location accuracy too low (±150 m)',
          ],
          at: AT,
          workDate: '2026-10-16',
          distanceM: 240,
          lateMin: 0,
          projectName: 'Riverside Tower',
        }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt('/attendance');
    await user.click(await screen.findByRole('button', { name: 'Check out' }));
    expect(await screen.findByText('Hold still… 3')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(await screen.findByText('Sent for approval')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toContain('Outside site radius (240 m, allowed 100 m)');
    expect(items).toContain('Location accuracy too low (±150 m)');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Done for today')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check out' })).toBeNull();
  });

  it('already checked in goes back to the status view with a fresh copy of today', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const posted = setup({
      check: () =>
        json(409, {
          error: { code: 'already_checked_in', message: 'You have already checked in today.' },
        }),
    });
    await reachHold();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeTruthy();
    expect(posted.todayLoads).toBe(2);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('cancels the hold when the face is lost', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const posted = setup({ check: () => json(200, checkedIn) });
    await reachHold();
    guide.state = { kind: 'no-face' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByText(/Hold still/)).toBeNull();
    expect(screen.getByText('Look at the camera')).toBeTruthy();
    expect(guide.resetBlink).toHaveBeenCalled();
    expect(posted.check).toBeUndefined();
  });

  it('gives up when the location never comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    stubDevices(undefined, false);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt('/attendance');
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    expect(screen.getByText('Finding your location…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(
      screen.getByText('Could not find your location. Step into the open and try again.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('stops the camera when the face check keeps failing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    guide.next.mockRejectedValue(new Error('models failed'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderAt('/attendance');
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      screen.getByText('The face check could not start. Check your connection and try again.'),
    ).toBeTruthy();
    expect(guide.next).toHaveBeenCalledTimes(20);
    expect(guide.stop).toHaveBeenCalled();
  });

  it('shows a plain message when the camera is blocked', async () => {
    setup();
    stubDevices(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    renderAt('/attendance');
    await userEvent.click(await screen.findByRole('button', { name: 'Check in' }));
    expect(
      await screen.findByText(
        'Camera is blocked. Allow camera for this site in your browser settings.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows not set up when the project has no site location', async () => {
    setup({ today: today({ setUp: false }) });
    renderAt('/attendance');
    expect(await screen.findByText(/Attendance is not set up for this project yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
  });

  it('asks to register the face when none is approved', async () => {
    setup({ today: today({ face: 'none' }) });
    renderAt('/attendance');
    expect(await screen.findByRole('link', { name: 'Register your face' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
  });
});
