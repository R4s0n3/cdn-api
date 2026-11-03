import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import HttpError from '../models/http-error';

export default function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) {
    next(error);
    return;
  }

  const err = error as {
    code?: number | string;
    message?: string;
    status?: number;
  };
  let status = 500;

  if (error instanceof HttpError) {
    status = error.code;
  } else if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  } else if (typeof err.code === 'number') {
    status = err.code;
  } else if (typeof err.status === 'number') {
    status = err.status;
  } else if (err.message && /invalid file type/i.test(err.message)) {
    status = 400;
  }

  if (status >= 500) {
    console.error('request failed', {
      method: req.method,
      path: req.originalUrl.startsWith('/share/')
        ? '/share/[redacted]'
        : req.originalUrl,
      status,
    });
  }

  const message =
    status >= 500 ? 'An unknown error occurred!' : err.message || 'Bad request';

  res.status(status).json({ message });
}
