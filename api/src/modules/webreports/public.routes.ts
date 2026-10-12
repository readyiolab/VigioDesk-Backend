import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { webreportsPublicLimiter } from '../../middleware/rateLimit.middleware';
import { publicWebReportsController } from './webreports.controller';
import { shareTokenSchema } from './webreports.types';

const router = Router();

router.get('/:token', webreportsPublicLimiter, validate(shareTokenSchema), publicWebReportsController.get);

export default router;
