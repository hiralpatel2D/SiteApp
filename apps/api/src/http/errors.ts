import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
    );
  }
  if (err instanceof HTTPException && err.status < 500) {
    return c.json(
      { error: { code: 'bad_request', message: 'The request was not valid.' } },
      err.status,
    );
  }
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'Something went wrong. Try again.' } }, 500);
};

export const notFoundHandler: NotFoundHandler = (c) =>
  c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
