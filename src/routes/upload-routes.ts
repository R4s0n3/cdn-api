import express from 'express';

import uploadControllers from '../controllers/upload-controllers';
import { listMedia, deleteMedia } from '../controllers/media-controllers';
import validateKey from '../middleware/validate-key';
import {
  strictUploadLimit,
  upload,
  uploadLimit,
} from '../util/upload-functions';

const router = express.Router();

router.get('/', uploadControllers.getHealth);

router.use(validateKey);

router.get('/files', listMedia);
router.delete('/files/:id', deleteMedia);

router.post(
  '/single',
  uploadLimit,
  upload.single('file'),
  uploadControllers.uploadFile,
);

router.post(
  '/bulk',
  strictUploadLimit,
  upload.array('files', 5),
  uploadControllers.bulkUpload,
);

export default router;
