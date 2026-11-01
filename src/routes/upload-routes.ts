import express from 'express';
import uploadControllers from '../controllers/upload-controllers';
import validateKey from '../middleware/validate-key';
import { assetUpload, strictUploadLimit, upload, uploadLimit } from '../util/upload-functions';

const router = express.Router();

router.get('/', uploadControllers.getHealth);

router.use(validateKey);

router.post('/single',
  uploadLimit,
  upload.single('file'),
  uploadControllers.uploadFile,
);

router.post('/bulk',
  strictUploadLimit,
  upload.array('files', 5),
  uploadControllers.bulkUpload,
);

router.post('/asset',
  uploadLimit,
  assetUpload.single('file'),
  uploadControllers.uploadAsset,
);

export default router;
