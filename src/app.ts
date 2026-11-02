import cors from 'cors';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';

import { type AppConfig } from './config';
import {
  getLiveness,
  getReadiness,
} from './controllers/health-controllers';
import {
  createInstallGuideHandler,
  INSTALL_GUIDE_PATH,
  loadInstallGuide,
  redirectToInstallGuide,
} from './install-guide';
import HttpError from './models/http-error';
import storageRoutes from './routes/storage-routes';
import uploadRoutes from './routes/upload-routes';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new HttpError('File exceeds the 50 MB upload limit', 413);
    }

    return new HttpError(error.message, 400);
  }

  return new HttpError('An unknown error occurred', 500);
}

export function createApp(config: AppConfig): express.Express {
  const app = express();
  const installGuideHandler = createInstallGuideHandler(
    loadInstallGuide(config.publicApiBaseUrl),
  );

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
        'Range',
        'X-API-Key',
      ],
      exposedHeaders: [
        'Accept-Ranges',
        'Cache-Control',
        'Content-Length',
        'Content-Disposition',
        'Content-Range',
        'Content-Type',
        'ETag',
        'Last-Modified',
        'X-Content-Type-Options',
      ],
    }),
  );

  app.get('/', (_req: Request, res: Response) => {
    res.send('online');
  });
  app.get('/health/live', getLiveness);
  app.get('/health/ready', getReadiness);
  app.use('/storage', storageRoutes);
  app.get('/api/install', redirectToInstallGuide);
  app.head(INSTALL_GUIDE_PATH, installGuideHandler);
  app.get(INSTALL_GUIDE_PATH, installGuideHandler);

  app.use(apiLimiter);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/upload', uploadRoutes);

  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new HttpError('Could not find this route', 404));
  });

  app.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }

      const httpError = normalizeError(error);
      if (httpError.code >= 500) {
        console.error(httpError);
      }

      res.status(httpError.code).json({ message: httpError.message });
    },
  );

  return app;
}
