import { getActiveCompany } from './company';

const UNAVAILABLE = 'The service is busy. Try again shortly.';

/** An API failure, built from the `{ error: { code, message, details? } }` shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string>;

  constructor(status: number, code: string, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ApiOptions = {
  method?: string;
  body?: unknown;
  /** Company id for `x-company-id`; defaults to the active company. */
  company?: string | null;
};

type ErrorBody = { error?: { code?: unknown; message?: unknown; details?: unknown } };

/** Turns any thrown value into the message to show (catalogue copy for API errors). */
export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : UNAVAILABLE;
}

/** Builds an ApiError from a failed response (our error shape, or a generic fallback). */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody | undefined;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = undefined;
  }
  const e = body?.error;
  if (e && typeof e.code === 'string' && typeof e.message === 'string') {
    const details =
      e.details && typeof e.details === 'object'
        ? (e.details as Record<string, string>)
        : undefined;
    return new ApiError(res.status, e.code, e.message, details);
  }
  return new ApiError(res.status, 'unavailable', UNAVAILABLE);
}

/**
 * Same-origin JSON request to the API. Sends the session cookie and the active
 * company (`x-company-id`); throws `ApiError` on any non-2xx response.
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  const company = opts.company === undefined ? getActiveCompany() : opts.company;
  if (company) headers.set('x-company-id', company);
  const hasBody = opts.body !== undefined;
  if (hasBody) headers.set('content-type', 'application/json');

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (hasBody ? 'POST' : 'GET'),
      headers,
      credentials: 'include',
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'unavailable', UNAVAILABLE);
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
