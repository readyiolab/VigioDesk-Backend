import { Router } from 'express';
import { authMiddleware, requireFullAccount, requireVerifiedEmail } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { webreportsCreateLimiter, webreportsPollLimiter } from '../../middleware/rateLimit.middleware';
import { webreportsController } from './webreports.controller';
import { webreportsIntegrationsController } from './integrations.controller';
import {
  createWebReportSchema,
  historyByReportSchema,
  historyWebReportsSchema,
  integrationBacklinksSchema,
  integrationExchangeSchema,
  integrationGoogleProviderSchema,
  integrationMetricsSchema,
  integrationPropertySchema,
  integrationProviderSchema,
  listWebReportsSchema,
  reportIdSchema,
  rescanSchema,
  updateBrandingSchema,
} from './webreports.types';

const router = Router();

router.use(authMiddleware, requireFullAccount, requireVerifiedEmail);

router.post('/', webreportsCreateLimiter, validate(createWebReportSchema), webreportsController.create);
router.get('/', validate(listWebReportsSchema), webreportsController.list);
router.get('/history', validate(historyWebReportsSchema), webreportsController.history);
router.get('/schedules', webreportsController.listSchedules);
router.post('/schedules', webreportsCreateLimiter, webreportsController.createSchedule);
router.delete('/schedules/:scheduleId', webreportsController.deleteSchedule);

router.get('/integrations', webreportsIntegrationsController.status);
router.get('/integrations/metrics', validate(integrationMetricsSchema), webreportsIntegrationsController.metrics);
router.get(
  '/integrations/:provider/authorize',
  validate(integrationGoogleProviderSchema),
  webreportsIntegrationsController.authorize
);
router.post('/integrations/exchange', validate(integrationExchangeSchema), webreportsIntegrationsController.exchange);
router.delete(
  '/integrations/:provider',
  validate(integrationProviderSchema),
  webreportsIntegrationsController.disconnect
);
router.post('/integrations/backlinks', validate(integrationBacklinksSchema), webreportsIntegrationsController.saveBacklinks);
router.get(
  '/integrations/:provider/properties',
  validate(integrationGoogleProviderSchema),
  webreportsIntegrationsController.listProperties
);
router.patch(
  '/integrations/:provider/property',
  validate(integrationPropertySchema),
  webreportsIntegrationsController.setProperty
);

router.get('/:id/history', webreportsPollLimiter, validate(historyByReportSchema), webreportsController.historyForReport);
router.get('/:id', webreportsPollLimiter, validate(reportIdSchema), webreportsController.get);
router.post('/:id/rescan', webreportsCreateLimiter, validate(rescanSchema), webreportsController.rescan);
router.patch('/:id/branding', validate(updateBrandingSchema), webreportsController.updateBranding);
router.post('/:id/share', validate(reportIdSchema), webreportsController.share);
router.delete('/:id/share', validate(reportIdSchema), webreportsController.revoke);
router.delete('/:id', validate(reportIdSchema), webreportsController.remove);

export default router;
