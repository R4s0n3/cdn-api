import express from 'express';
import s3Controllers from '../controllers/s3-upload-controllers';
import { upload as s3Upload } from '../util/upload-functions';
import { listMedia, deleteMedia } from '../controllers/media-controllers';
import uploadControllers from '../controllers/upload-controllers';
import validateKey from '../middleware/validate-key';
import {
  assetUpload,
  strictUploadLimit,
  upload,
  uploadLimit,
} from '../util/disk-upload-functions';

const router = express.Router();

router.get('/', uploadControllers.getHealth);

router.use(validateKey);
router.get('/files', listMedia);
router.delete('/files/:id', deleteMedia);

const activeUpload: typeof upload = process.env.S3_ENDPOINT ? s3Upload : upload;
const controllers = process.env.S3_ENDPOINT ? s3Controllers : uploadControllers;

router.post(
  '/single',
  uploadLimit,
  activeUpload.single('file'),
  controllers.uploadFile,
);

router.post(
  '/bulk',
  strictUploadLimit,
  activeUpload.array('files', 5),
  controllers.bulkUpload,
);

router.post(
  '/asset',
  uploadLimit,
  assetUpload.single('file'),
  uploadControllers.uploadAsset,
);

export default router;
