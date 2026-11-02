import express from 'express';

import {
  getStoredFile,
  headStoredFile,
} from '../controllers/storage-controllers';

const router = express.Router();

router.head('/:cluster/:fileName', headStoredFile);
router.get('/:cluster/:fileName', getStoredFile);

export default router;
