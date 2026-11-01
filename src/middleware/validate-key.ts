import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import HttpError from '../models/http-error';


const validateKey = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const apiKey = req.header('X-API-Key');

  if (!apiKey) {
    const error = new HttpError('API-KEY missing.', 401);
    return next(error);
  }

  try {
    const existingApiKey = await checkKey(apiKey);

    if (!existingApiKey) {
      const error = new HttpError('Invalid API-KEY.', 403);
      return next(error);
    }

    (req as any).userId = existingApiKey.createdById;
    (req as any).apiKey = existingApiKey.key;
    
    next();
  } catch {
    console.error('Database error when checking API key');
    return next(new HttpError('Internal server error. Try again later.', 500));
  }
};

export default validateKey;

async function checkKey(apiKey: string) {
  return db.apiKey.findUnique({
    where: {
      key: apiKey,
    },
  });
}
