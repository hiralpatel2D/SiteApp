import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { GuideState } from '../src/attendance/face-guide';
import { routeTree } from '../src/routeTree.gen';
import { setActiveCompany } from '../src/lib/company';
import { setActiveProject } from '../src/lib/project';

const guide = vi.hoisted(() => ({
  states: [] as GuideState[],
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
/** 08:52 in Asia/Kolkata. */
const AT = '2026-10-16T03:22:00.000Z';

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
      roleName: 'Project Manager',
      status: 'active',
    },
  ],
};

const projects = [
  {
    id: P1,
    name: 'Riverside Tower',
    code: 'RT-P2',
    location: 'Pune',
    status: 'active',
    memberCount: 3,
    version: 1,
  },
];

const entry = (status: string) => ({
  status,
  at: AT,
  distanceM: 20,
  lateMin: 0,
  reasons: [],
});

const pendingEntry = {
  id: 'e1',
  own: false,
  canDecide: true,
  name: 'Ravi Kumar',
  projectName: 'Riverside Tower',
  kind: 'check_in',
  at: AT,
  workDate: '2026-10-16',
  reasons: ['Outside site radius (240 m, allowed 100 m)', 'Location accuracy too low (±120 m)'],
  distanceM: 239.6,
  accuracyM: 120.4,
  similarity: 0.82,
  lat: 18.522,
  lng: 73.857,
  siteLat: 18.5204,
  siteLng: 73.8567,
  radiusM: 100,
  photos: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
};

type Calls = Record<string, unknown[]>;

function setup(
  capabilities: string[],
  routes: Record<string, (init?: RequestInit) => Response> = {},
): Calls {
  const calls: Calls = {};
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.replace(/\?.*$/, '')}`;
    (calls[key] ??= []).push(init?.body ? JSON.parse(String(init.body)) : undefined);
    if (url.includes('/api/me')) return Promise.resolve(json(200, me));
    if (url.includes('/api/company/context'))
      return Promise.resolve(
        json(200, {
          company: { id: COMPANY_ID, name: 'V and P', slug: 'vp' },
          role: { id: 'r1', name: 'Project Manager', key: null },
          capabilities,
        }),
      );
    if (url.includes('/api/projects')) return Promise.resolve(json(200, projects));
    const handler = routes[key];
    if (handler) return Promise.resolve(handler(init));
    return Promise.resolve(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function stubLocation(accuracy: number) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: PositionCallback) =>
        ok({
          coords: { latitude: 18.5204123, longitude: 73.8567456, accuracy },
          timestamp: Date.now(),
        } as GeolocationPosition),
    },
  });
}

const track = { stop: vi.fn() };
const stream = { getTracks: () => [track] };

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const TODAY = `GET /api/attendance/today`;

describe('Attendance admin and Home tile', () => {
  beforeEach(() => {
    setActiveCompany(COMPANY_ID);
    setActiveProject(COMPANY_ID, P1);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setActiveCompany(null);
    setActiveProject(COMPANY_ID, null);
  });

  it('tile turns green after a recorded check-in', async () => {
    setup(['projects.view', 'attendance.view'], {
      [TODAY]: () =>
        json(200, { setUp: true, face: 'approved', checkIn: entry('recorded'), checkOut: null }),
    });
    renderAt('/home');
    const tile = await screen.findByRole('link', { name: /Self Attendance/ });
    expect(await within(tile).findByText('Checked in 08:52')).toBeTruthy();
    expect(tile.className).toContain('bg-good-bg');
    expect(tile.getAttribute('href')).toBe('/attendance');
    expect(within(tile).queryByText('Pending approval')).toBeNull();
    // The other modules are still to come.
    const tiles = screen.getByRole('list', { name: 'Modules' });
    expect(within(tiles).getAllByText('Coming soon')).toHaveLength(11);
  });

  it('tile shows Pending approval chip', async () => {
    setup(['projects.view', 'attendance.view'], {
      [TODAY]: () =>
        json(200, { setUp: true, face: 'approved', checkIn: entry('pending'), checkOut: null }),
    });
    renderAt('/home');
    const tile = await screen.findByRole('link', { name: /Self Attendance/ });
    const chip = await within(tile).findByText('Pending approval');
    // Small text stays on the text colour; amber is the border and a decorative dot.
    expect(chip.className).toContain('text-text');
    expect(chip.className).toContain('border-warn');
    expect(chip.className).not.toContain('text-warn');
    expect(chip.querySelector('[aria-hidden="true"]')?.className).toContain('bg-warn');
    expect(tile.className).not.toContain('bg-good-bg');
  });

  it('tile stays a Coming soon card without attendance.view', async () => {
    const calls = setup(['projects.view'], {
      [TODAY]: () =>
        json(200, { setUp: true, face: 'approved', checkIn: entry('recorded'), checkOut: null }),
    });
    renderAt('/home');
    expect(await screen.findByRole('heading', { name: 'Riverside Tower' })).toBeTruthy();
    const tiles = screen.getByRole('list', { name: 'Modules' });
    expect(within(tiles).getByRole('heading', { name: 'Self Attendance' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Self Attendance/ })).toBeNull();
    expect(within(tiles).getAllByText('Coming soon')).toHaveLength(12);
    expect(calls[TODAY]).toBeUndefined();
  });

  it('tile says when attendance is not set up or nothing is marked', async () => {
    setup(['projects.view', 'attendance.view'], {
      [TODAY]: () => json(200, { setUp: false, face: 'none', checkIn: null, checkOut: null }),
    });
    renderAt('/home');
    const tile = await screen.findByRole('link', { name: /Self Attendance/ });
    expect(await within(tile).findByText('Not set up for this project')).toBeTruthy();
  });

  it.each([
    ['none', 'Register your face'],
    ['rejected', 'Register your face'],
    ['pending', 'Face registration pending approval'],
  ] as const)('tile with face status %s says %s', async (face, line) => {
    setup(['projects.view', 'attendance.view'], {
      [TODAY]: () => json(200, { setUp: true, face, checkIn: null, checkOut: null }),
    });
    renderAt('/home');
    const tile = await screen.findByRole('link', { name: /Self Attendance/ });
    expect(await within(tile).findByText(line)).toBeTruthy();
    expect(tile.className).not.toContain('bg-good-bg');
  });

  it('tile with an approved face and nothing marked says Not checked in', async () => {
    setup(['projects.view', 'attendance.view'], {
      [TODAY]: () => json(200, { setUp: true, face: 'approved', checkIn: null, checkOut: null }),
    });
    renderAt('/home');
    const tile = await screen.findByRole('link', { name: /Self Attendance/ });
    expect(await within(tile).findByText('Not checked in')).toBeTruthy();
  });

  it('settings refuses a location worse than 50 m', async () => {
    setup(['projects.view', 'attendance.settings'], {
      [`GET /api/attendance/settings/${P1}`]: () => json(200, { settings: null }),
    });
    stubLocation(80);
    renderAt('/attendance/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Use my current location' }));
    expect(
      await screen.findByText(
        'Location not accurate enough (±80 m). Move to open sky and try again.',
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText('Latitude') as HTMLInputElement).value).toBe('');
  });

  it('settings saves a good location with the current version', async () => {
    const calls = setup(['projects.view', 'attendance.settings'], {
      [`GET /api/attendance/settings/${P1}`]: () =>
        json(200, {
          settings: {
            lat: 18.5,
            lng: 73.8,
            radiusM: 150,
            startTime: '08:30',
            lateAfterMin: 10,
            reminderTime: '19:00',
            timezone: 'Asia/Kolkata',
            version: 3,
          },
        }),
      [`PUT /api/attendance/settings/${P1}`]: (init) =>
        json(200, {
          settings: { ...JSON.parse(String(init?.body)), timezone: 'Asia/Kolkata', version: 4 },
        }),
    });
    stubLocation(12);
    renderAt('/attendance/settings');
    expect(await screen.findByText('150 m')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect((screen.getByLabelText('Latitude') as HTMLInputElement).value).toBe('18.520412');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    expect(calls[`PUT /api/attendance/settings/${P1}`]?.[0]).toEqual({
      lat: 18.520412,
      lng: 73.856746,
      radiusM: 150,
      startTime: '08:30',
      lateAfterMin: 10,
      reminderTime: '19:00',
      version: 3,
    });
  });

  it('approvals approve a face and remove it from the list', async () => {
    const calls = setup(['attendance.approve_face', 'attendance.review'], {
      'GET /api/attendance/face/pending': () =>
        json(200, {
          pending: [
            {
              id: 'f1',
              membershipId: 'm1',
              own: false,
              canDecide: true,
              name: 'Ravi Kumar',
              email: 'ravi@x.test',
              createdAt: AT,
              photo: 'data:image/jpeg;base64,AAAA',
            },
            {
              id: 'f2',
              membershipId: 'm2',
              own: false,
              canDecide: true,
              name: 'Sita Rao',
              email: 'sita@x.test',
              createdAt: AT,
              photo: 'data:image/jpeg;base64,BBBB',
            },
          ],
        }),
      'POST /api/attendance/face/f1/approve': () => json(200, { status: 'approved' }),
      'GET /api/attendance/pending': () => json(200, { entries: [], total: 0 }),
    });
    renderAt('/attendance/approvals');
    expect(await screen.findByRole('tab', { name: 'Faces' })).toBeTruthy();
    const row = (await screen.findByText('Ravi Kumar')).closest('li')!;
    expect(within(row).getByText('ravi@x.test')).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'Ravi Kumar' })).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByText('Ravi Kumar')).toBeNull());
    expect(screen.getByText('Sita Rao')).toBeTruthy();
    expect(calls['POST /api/attendance/face/f1/approve']).toHaveLength(1);
  });

  it.each([
    ['cannot be decided yet', false],
    ['can be decided by the only approver', true],
  ])('approvals list your own registration that %s', async (_, canDecide) => {
    setup(['attendance.approve_face'], {
      'GET /api/attendance/face/pending': () =>
        json(200, {
          pending: [
            {
              id: 'me1',
              membershipId: 'mm',
              own: true,
              canDecide,
              name: 'Hiral Owner',
              email: 'owner@x.test',
              createdAt: AT,
              photo: 'data:image/jpeg;base64,CCCC',
            },
          ],
        }),
    });
    renderAt('/attendance/approvals');
    const row = (await screen.findByText('Hiral Owner')).closest('li')!;
    expect(within(row).getByText('Your registration')).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'Hiral Owner' })).toBeTruthy();
    expect(!!within(row).queryByRole('button', { name: 'Approve' })).toBe(canDecide);
    expect(!!within(row).queryByText(/Another approver has to approve/)).toBe(!canDecide);
  });

  it.each([
    ['cannot be decided yet', false],
    ['can be decided by the only reviewer', true],
  ])('approvals list your own check-in that %s', async (_, canDecide) => {
    setup(['attendance.review'], {
      'GET /api/attendance/pending': () =>
        json(200, {
          entries: [{ ...pendingEntry, id: 'mine', name: 'Hiral Owner', own: true, canDecide }],
          total: 1,
        }),
    });
    renderAt('/attendance/approvals');
    const row = (await screen.findByText('Hiral Owner')).closest('li')!;
    expect(within(row).getByText('Your check-in')).toBeTruthy();
    expect(within(row).getByText('Outside site radius (240 m, allowed 100 m)')).toBeTruthy();
    expect(!!within(row).queryByRole('button', { name: 'Approve' })).toBe(canDecide);
    expect(!!within(row).queryByText(/Another approver has to decide/)).toBe(!canDecide);
  });

  it('approvals show reasons for a pending check-in', async () => {
    let loads = 0;
    const calls = setup(['attendance.review'], {
      'GET /api/attendance/pending': () =>
        ++loads === 1
          ? json(200, { entries: [pendingEntry], total: 73 })
          : json(200, { entries: [{ ...pendingEntry, id: 'e2', name: 'Sita Rao' }], total: 72 }),
      'POST /api/attendance/pending/e1/reject': () => json(200, { status: 'rejected' }),
    });
    renderAt('/attendance/approvals');
    const row = (await screen.findByText('Ravi Kumar')).closest('li')!;
    // Only the tab the person may use.
    expect(screen.queryByRole('tab', { name: 'Faces' })).toBeNull();
    expect(within(row).getByText('Outside site radius (240 m, allowed 100 m)')).toBeTruthy();
    expect(within(row).getByText('Location accuracy too low (±120 m)')).toBeTruthy();
    expect(within(row).getByText('240 m from site (allowed 100 m) · ±120 m')).toBeTruthy();
    expect(within(row).getByText(/Riverside Tower · Check in · 08:52/)).toBeTruthy();
    expect(within(row).getByText('Match score 0.82')).toBeTruthy();
    expect(within(row).getAllByRole('img')).toHaveLength(2);
    expect(screen.getByText('Showing 1 of 73')).toBeTruthy();

    await userEvent.type(within(row).getByLabelText('Note (optional)'), 'Was at the gate');
    await userEvent.click(within(row).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.queryByText('Ravi Kumar')).toBeNull());
    expect(calls['POST /api/attendance/pending/e1/reject']?.[0]).toEqual({
      note: 'Was at the gate',
    });
    // The last shown row went while more wait: the next ones load.
    expect(await screen.findByText('Sita Rao')).toBeTruthy();
  });

  it('approvals show the already-decided message and refresh', async () => {
    let loads = 0;
    setup(['attendance.review'], {
      'GET /api/attendance/pending': () => {
        loads++;
        return json(
          200,
          loads === 1 ? { entries: [pendingEntry], total: 1 } : { entries: [], total: 0 },
        );
      },
      'POST /api/attendance/pending/e1/approve': () =>
        json(409, {
          error: { code: 'already_decided', message: 'Someone already decided this one.' },
        }),
    });
    renderAt('/attendance/approvals');
    const row = (await screen.findByText('Ravi Kumar')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Someone already decided this one.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Ravi Kumar')).toBeNull());
    expect(loads).toBe(2);
  });

  it('approvals menu item hidden without the capabilities', async () => {
    setup(['projects.view']);
    renderAt('/home');
    expect(await screen.findByRole('link', { name: 'Home' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Approvals' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Site settings' })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('approvals and site settings menu items show with the capabilities', async () => {
    setup(['projects.view', 'attendance.approve_face', 'attendance.settings']);
    renderAt('/home');
    const link = await screen.findByRole('link', { name: 'Approvals' });
    expect(link.getAttribute('href')).toBe('/attendance/approvals');
    expect(screen.getByRole('link', { name: 'Site settings' }).getAttribute('href')).toBe(
      '/attendance/settings',
    );
  });
});

describe('Register face', () => {
  beforeEach(() => {
    setActiveCompany(COMPANY_ID);
    guide.states = [
      { kind: 'no-face' },
      { kind: 'ready', blinked: true, yaw: 'centre' },
      { kind: 'ready', blinked: false, yaw: 'left' },
      { kind: 'ready', blinked: false, yaw: 'right' },
      { kind: 'ready', blinked: false, yaw: 'centre' },
    ];
    guide.next
      .mockReset()
      .mockImplementation(async () =>
        guide.states.length > 1 ? guide.states.shift()! : guide.states[0]!,
      );
    let n = 0;
    guide.capture.mockReset().mockImplementation(async () => `F${n++}AA`);
    guide.resetBlink.mockReset();
    guide.stop.mockReset();
    track.stop.mockReset();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setActiveCompany(null);
  });

  it('asks for consent, captures 5 frames across the poses and sends them', async () => {
    const calls = setup([], {
      'GET /api/attendance/face/me': () => json(200, { status: 'none' }),
      'POST /api/attendance/face': () => json(200, { status: 'pending' }),
    });
    renderAt('/attendance/register');
    expect(
      await screen.findByText(
        "Site Diary keeps a numeric face code to confirm it's you at check-in. One photo is kept until a senior approves or rejects your registration, then deleted. To remove your face code, ask your company admin to request deletion from Site Diary support. If a check-in needs review, its photos are kept for the reviewer.",
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'I agree' }));
    expect(
      await screen.findByText('Registered. Your photo is waiting for approval.', undefined, {
        timeout: 4000,
      }),
    ).toBeTruthy();
    const body = calls['POST /api/attendance/face']?.[0] as { consent: boolean; frames: string[] };
    expect(body.consent).toBe(true);
    expect(body.frames).toEqual(['F0AA', 'F1AA', 'F2AA', 'F3AA', 'F4AA']);
    expect(guide.stop).toHaveBeenCalled();
  });

  it('shows a 422 message with Try again', async () => {
    setup([], {
      'GET /api/attendance/face/me': () => json(200, { status: 'none' }),
      'POST /api/attendance/face': () =>
        json(422, {
          error: { code: 'face_not_clear', message: 'Face not clear. Try again in better light.' },
        }),
    });
    renderAt('/attendance/register');
    await userEvent.click(await screen.findByRole('button', { name: 'I agree' }));
    expect(
      await screen.findByText('Face not clear. Try again in better light.', undefined, {
        timeout: 4000,
      }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('on a 409 shows the current status instead of Try again', async () => {
    let faceLoads = 0;
    setup([], {
      'GET /api/attendance/face/me': () =>
        json(200, { status: ++faceLoads === 1 ? 'none' : 'pending' }),
      'POST /api/attendance/face': () =>
        json(409, {
          error: {
            code: 'registration_in_progress',
            message: 'A registration is already being processed.',
          },
        }),
    });
    renderAt('/attendance/register');
    await userEvent.click(await screen.findByRole('button', { name: 'I agree' }));
    expect(
      await screen.findByText(
        'Your face registration is waiting for approval by a senior.',
        undefined,
        { timeout: 4000 },
      ),
    ).toBeTruthy();
    expect(screen.getByText('A registration is already being processed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(faceLoads).toBe(2);
  });

  it('Cancel releases the camera', async () => {
    guide.states = [{ kind: 'no-face' }];
    const calls = setup([], {
      'GET /api/attendance/face/me': () => json(200, { status: 'none' }),
    });
    renderAt('/attendance/register');
    await userEvent.click(await screen.findByRole('button', { name: 'I agree' }));
    expect(await screen.findByText('Look at the camera')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'I agree' })).toBeTruthy();
    expect(guide.stop).toHaveBeenCalled();
    expect(calls['POST /api/attendance/face']).toBeUndefined();
  });

  it('leaving the page releases the camera', async () => {
    guide.states = [{ kind: 'no-face' }];
    setup([], { 'GET /api/attendance/face/me': () => json(200, { status: 'none' }) });
    const router = renderAt('/attendance/register');
    await userEvent.click(await screen.findByRole('button', { name: 'I agree' }));
    expect(await screen.findByText('Look at the camera')).toBeTruthy();
    await router.navigate({ to: '/home' });
    await waitFor(() => expect(guide.stop).toHaveBeenCalled());
  });
});
