import { Router } from 'express';
import { authMiddleware, requireFullAccount, requireVerifiedEmail } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { webreportsCreateLimiter, webreportsPollLimiter } from '../../middleware/rateLimit.middleware';
import { webreportsController } from './webreports.controller';
import { createWebReportSchema, listWebReportsSchema, reportIdSchema, rescanSchema } from './webreports.types';

const router = Router();

router.use(authMiddleware, requireFullAccount, requireVerifiedEmail);

router.post('/', webreportsCreateLimiter, validate(createWebReportSchema), webreportsController.create);
router.get('/', validate(listWebReportsSchema), webreportsController.list);
router.get('/:id', webreportsPollLimiter, validate(reportIdSchema), webreportsController.get);
router.post('/:id/rescan', webreportsCreateLimiter, validate(rescanSchema), webreportsController.rescan);
router.post('/:id/share', validate(reportIdSchema), webreportsController.share);
router.delete('/:id/share', validate(reportIdSchema), webreportsController.revoke);
router.delete('/:id', validate(reportIdSchema), webreportsController.remove);

export default router;
