import { uploadPrivateFiles } from '../controllers/private-upload-controllers';
import {
  getPrivateStorage,
  privateStorageLocation,
} from '../storage/private-storage';
import { makeFilePrivate } from '../controllers/file-privacy-controllers';
import { downloadOwnerFile } from '../controllers/private-file-controllers';
import HttpError from '../models/http-error';
import {
  createShare,
  listShares,
  revokeShare,
  privateShareHeaders,
} from '../controllers/share-controllers';
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
router.get('/capabilities', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let privateMedia = false;
  try {
    const location = privateStorageLocation('capability-check');
    await getPrivateStorage(location.bucket).verifyPrivateAccess();
    privateMedia = true;
  } catch {
    /* Fail closed until S3 is configured. */
  }
  res.json({ privateMedia, mediaShares: true, privateStorage: 's3' });
});
router.use((req, _res, next) => {
  const visibility = req.header('X-Upload-Visibility');
  if (visibility === 'private' && req.path === '/asset') {
    next(
      new HttpError(
        'Named assets are public. Use the private file upload endpoint instead.',
        400,
      ),
    );
    return;
  }
  if (visibility && visibility !== 'public' && visibility !== 'private') {
    next(new HttpError('Invalid upload visibility', 400));
    return;
  }
  if (visibility === 'private') {
    try {
      privateStorageLocation('configuration-check');
    } catch (error) {
      next(error);
      return;
    }
  }
  next();
});
router.get('/files/:id/download', privateShareHeaders, downloadOwnerFile);
router.post('/files/:id/private', privateShareHeaders, makeFilePrivate);
router.use('/shares', privateShareHeaders);
router.get('/shares', listShares);
router.post('/shares', createShare);
router.delete('/shares/:id', revokeShare);
router.get('/files', listMedia);
router.delete('/files/:id', deleteMedia);

// Private uploads use temporary staging followed by verified private S3 storage.
const publicUpload: typeof upload = process.env.S3_ENDPOINT ? s3Upload : upload;
const publicControllers = process.env.S3_ENDPOINT
  ? s3Controllers
  : uploadControllers;
const privateUpload = s3Upload.single('file');
const defaultUpload = publicUpload.single('file');
router.post(
  '/single',
  uploadLimit,
  (req, res, next) => {
    (req.header('X-Upload-Visibility') === 'private'
      ? privateUpload
      : defaultUpload)(req, res, next);
  },
  (req, res, next) => {
    if (req.header('X-Upload-Visibility') === 'private') {
      void uploadPrivateFiles(req, res, next);
      return;
    }
    void publicControllers.uploadFile(req, res, next);
  },
);
const privateBulk = s3Upload.array('files', 5);
const defaultBulk = publicUpload.array('files', 5);
router.post(
  '/bulk',
  strictUploadLimit,
  (req, res, next) => {
    (req.header('X-Upload-Visibility') === 'private'
      ? privateBulk
      : defaultBulk)(req, res, next);
  },
  (req, res, next) => {
    if (req.header('X-Upload-Visibility') === 'private') {
      void uploadPrivateFiles(req, res, next);
      return;
    }
    void publicControllers.bulkUpload(req, res, next);
  },
);

router.post(
  '/asset',
  uploadLimit,
  assetUpload.single('file'),
  uploadControllers.uploadAsset,
);

export default router;
