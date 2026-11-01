import type { NextFunction, Request, Response } from 'express';
import HttpError from '../models/http-error';
import { apiKeysMatch } from '../util/api-key';

const validateKey = (req: Request, _res: Response, next: NextFunction) => {
  const provided = req.header('X-API-Key');
  if (!provided) {
    next(new HttpError('API-KEY missing.', 401));
    return;
  }

  const expected = process.env.CDN_API_KEY || '';
  if (!expected || !apiKeysMatch(provided, expected)) {
    next(new HttpError('Invalid API-KEY.', 403));
    return;
  }

  next();
};

export default validateKey;
