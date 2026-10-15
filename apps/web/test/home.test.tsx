import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '../src/routeTree.gen';
import { setActiveCompany } from '../src/lib/company';
import { getActiveProject, setActiveProject } from '../src/lib/project';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
      roleName: 'Super Admin',
      status: 'active',
    },
  ],
};

const project = (id: string, name: string, code: string) => ({
  id,
  name,
  code,
  location: 'Pune',
  status: 'active',
  memberCount: 0,
  version: 1,
});

function setup(capabilities: string[], projects: unknown[]) {
  let posted: unknown;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/me')) return Promise.resolve(json(200, me));
    if (url.includes('/api/company/context'))
      return Promise.resolve(
        json(200, {
          company: { id: COMPANY_ID, name: 'V and P', slug: 'vp' },
          role: { id: 'r1', name: 'Super Admin', key: 'super_admin' },
          capabilities,
        }),
      );
    if (url.includes('/api/projects') && init?.method === 'POST') {
      posted = JSON.parse(String(init.body));
      return Promise.resolve(json(201, project(P2, 'Lake View', 'LV-1')));
    }
    if (url.includes('/api/projects/') && init?.method === 'PATCH') {
      posted = JSON.parse(String(init.body));
      return Promise.resolve(json(200, {}));
    }
    if (url.includes('/api/projects')) return Promise.resolve(json(200, projects));
    return Promise.resolve(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posted: () => posted };
}

function renderAt(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const ALL = ['projects.view', 'projects.manage', 'projects.all', 'users.view'];

describe('Home (main app page)', () => {
  beforeEach(() => {
    setActiveCompany(COMPANY_ID);
    setActiveProject(COMPANY_ID, null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setActiveCompany(null);
    setActiveProject(COMPANY_ID, null);
  });

  it('shows the project, the module tiles and the bottom tabs', async () => {
    setup(ALL, [project(P1, 'Riverside Tower', 'RT-P2')]);
    renderAt('/home');
    expect(await screen.findByRole('heading', { name: 'Riverside Tower' })).toBeTruthy();
    const tiles = screen.getByRole('list', { name: 'Modules' });
    expect(within(tiles).getAllByRole('listitem')).toHaveLength(12);
    expect(within(tiles).getByRole('heading', { name: 'Self Attendance' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Today' }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches project and remembers the choice', async () => {
    setup(ALL, [project(P1, 'Riverside Tower', 'RT-P2'), project(P2, 'Lake View', 'LV-1')]);
    renderAt('/home');
    await userEvent.click(await screen.findByRole('button', { name: /Project: Riverside Tower/ }));
    await userEvent.click(screen.getByRole('button', { name: /Lake View/ }));
    expect(await screen.findByRole('heading', { name: 'Lake View' })).toBeTruthy();
    expect(getActiveProject(COMPANY_ID)).toBe(P2);
  });

  it('asks a manager to add the first project when there is none', async () => {
    setup(ALL, []);
    renderAt('/home');
    expect(await screen.findByRole('heading', { name: 'No project yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a project' })).toBeTruthy();
  });

  it('other tabs explain what is coming instead of showing fake data', async () => {
    setup(ALL, [project(P1, 'Riverside Tower', 'RT-P2')]);
    renderAt('/home');
    await userEvent.click(await screen.findByRole('tab', { name: 'Alerts' }));
    expect(screen.getByText(/will show here as those modules arrive/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Modules' })).toBeNull();
  });
});

describe('Projects page', () => {
  beforeEach(() => setActiveCompany(COMPANY_ID));
  afterEach(() => {
    vi.unstubAllGlobals();
    setActiveCompany(null);
    setActiveProject(COMPANY_ID, null);
  });

  it('adds a project and makes it the one Home opens', async () => {
    const api = setup(ALL, []);
    renderAt('/projects');
    await userEvent.type(await screen.findByLabelText('Project name'), 'Lake View');
    await userEvent.type(screen.getByLabelText('Short code'), 'lv-1');
    await userEvent.type(screen.getByLabelText('Location (optional)'), 'Pune');
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText('Lake View added. It now opens on Home.')).toBeTruthy();
    expect(api.posted()).toEqual({ name: 'Lake View', code: 'lv-1', location: 'Pune' });
    expect(getActiveProject(COMPANY_ID)).toBe(P2);
  });

  it('people who cannot manage projects only see the list', async () => {
    setup(['projects.view'], [project(P1, 'Riverside Tower', 'RT-P2')]);
    renderAt('/projects');
    expect(await screen.findByText('Riverside Tower')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('the Active switch makes a project inactive (and back)', async () => {
    const api = setup(ALL, [project(P1, 'Riverside Tower', 'RT-P2')]);
    renderAt('/projects');
    const toggle = await screen.findByRole('switch', { name: 'Riverside Tower active' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Inactive')).toBeTruthy();
    expect(api.posted()).toEqual({ version: 1, status: 'archived' });
  });
});
