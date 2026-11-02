import { type NextFunction, type Request, type Response } from 'express';

import { db } from '../db';
import HttpError from '../models/http-error';

const validateKey = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const apiKey = req.header('X-API-Key');

  if (!apiKey) {
    next(new HttpError('API-KEY missing', 401));
    return;
  }

  try {
    const existingApiKey = await db.apiKey.findFirst({
      where: {
        key: apiKey,
        deletedAt: null,
      },
    });

    if (!existingApiKey) {
      next(new HttpError('Invalid API-KEY', 403));
      return;
    }

    req.auth = {
      userId: existingApiKey.createdById,
      apiKey: existingApiKey.key,
    };

    next();
  } catch (error) {
    console.error('Database error while validating API key', error);
    next(new HttpError('Internal server error; try again later', 500));
  }
};

export default validateKey;
