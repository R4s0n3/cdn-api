import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { isAllowedOrigin } from './config';
import { ensureStorageLayout } from './util/paths';
import uploadRoutes from './routes/upload-routes';
import errorHandler from './middleware/error-handler';
import { assetFiles, storageFiles } from './middleware/public-files';

const apiLimiter = rateLimit({
  windowMs: 90 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

export function createApp() {
  ensureStorageLayout();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://miomideal.com https://*.miomideal.com",
    );
    next();
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.status(200).send('online');
  });

  app.use('/api', cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-API-Key'],
    maxAge: 86400,
  }));
  app.use('/api', apiLimiter);
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api/upload', uploadRoutes);

  app.use('/storage', storageFiles);
  app.use('/assets', assetFiles);

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ message: 'Could not find this route' });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).type('text/plain').send('Not found');
  });

  app.use(errorHandler);
  return app;
}
