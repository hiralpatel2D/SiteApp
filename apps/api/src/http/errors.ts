import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Maps a zod error to 400 `validation_failed`, with details keyed by dotted field path. */
export function validationError(error: ZodError): AppError {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (!(key in details)) details[key] = issue.message;
  }
  return new AppError(400, 'validation_failed', 'Check the highlighted fields.', details);
}

const HTTP_ERRORS: Partial<
  Record<number, { status: ContentfulStatusCode; code: string; message: string }>
> = {
  400: { status: 400, code: 'validation_failed', message: 'Check the highlighted fields.' },
  401: { status: 401, code: 'unauthenticated', message: 'Sign in to continue.' },
  403: { status: 403, code: 'forbidden', message: 'You do not have permission to do this.' },
  404: { status: 404, code: 'not_found', message: 'Not found.' },
  405: { status: 405, code: 'method_not_allowed', message: 'That action is not allowed here.' },
  429: {
    status: 429,
    code: 'rate_limited',
    message: 'Too many attempts. Wait a minute and try again.',
  },
  503: { status: 503, code: 'unavailable', message: 'The service is busy. Try again shortly.' },
};

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    const error: { code: string; message: string; details?: Record<string, string> } = {
      code: err.code,
      message: err.message,
    };
    if (err.details) error.details = err.details;
    return c.json({ error }, err.status);
  }
  if (err instanceof HTTPException) {
    const mapped = HTTP_ERRORS[err.status];
    if (mapped) {
      return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
    }
  }
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong. Try again.' } }, 500);
};

export const notFoundHandler: NotFoundHandler = (c) =>
  c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
