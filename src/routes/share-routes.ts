import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  downloadShareFile,
  getShare,
  privateShareHeaders,
} from '../controllers/share-controllers';

const router = express.Router();
router.use(privateShareHeaders);
router.use(
  rateLimit({
    windowMs: 60000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
router.get('/:token', getShare);
router.get('/:token/files/:fileId', downloadShareFile);
export default router;
