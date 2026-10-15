import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api';
import { setActiveCompany } from '../src/lib/company';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const call = () => fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = () => new Headers(call()[1].headers);

  it('sends credentials and JSON, and returns the parsed body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const out = await api<{ ok: boolean }>('/api/me');
    expect(out).toEqual({ ok: true });
    expect(call()[0]).toBe('/api/me');
    expect(call()[1].credentials).toBe('include');
    expect(call()[1].method).toBe('GET');
    expect(headers().get('accept')).toBe('application/json');
  });

  it('serialises a body as JSON and defaults the method to POST', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 1 }));
    await api('/api/platform/companies', { body: { name: 'Mehta Infra' } });
    expect(call()[1].method).toBe('POST');
    expect(call()[1].body).toBe(JSON.stringify({ name: 'Mehta Infra' }));
    expect(headers().get('content-type')).toBe('application/json');
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('throws ApiError with status, code, message and details from { error }', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'validation_failed',
          message: 'Check the highlighted fields.',
          details: { slug: 'Workspace name is not valid.' },
        },
      }),
    );
    const err = await api('/api/platform/companies', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation_failed');
    expect(e.message).toBe('Check the highlighted fields.');
    expect(e.details).toEqual({ slug: 'Workspace name is not valid.' });
  });

  it('throws a generic ApiError when the error body is not our shape', async () => {
    fetchMock.mockResolvedValue(new Response('Bad gateway', { status: 502 }));
    const e = (await api('/api/me').catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.code).toBe('unavailable');
    expect(e.message).toBe('The service is busy. Try again shortly.');
  });

  it('throws an ApiError when the network fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const e = (await api('/api/me').catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('unavailable');
  });

  it('sends x-company-id when an active company is set', async () => {
    setActiveCompany(ID);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api('/api/company/context');
    expect(headers().get('x-company-id')).toBe(ID);
  });

  it('an explicit company wins over the stored one', async () => {
    setActiveCompany(ID);
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api('/api/company/context', { company: 'other' });
    expect(headers().get('x-company-id')).toBe('other');
  });

  it('sends no x-company-id when none is set', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api('/api/me');
    expect(headers().has('x-company-id')).toBe(false);
  });

  it('storage throwing: no header, no crash', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await expect(api('/api/me')).resolves.toEqual({ ok: true });
    expect(headers().has('x-company-id')).toBe(false);
  });
});
