import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { sharedDiagramWriteLimiter } from '../../middleware/rateLimit.middleware';
import { diagramsController } from './diagrams.controller';
import {
  sharedTokenSchema,
  sharedUpdateSchema,
  sharedPresenceSchema,
  sharedPresenceLeaveSchema,
} from './diagrams.types';

/**
 * PUBLIC diagram share routes — mounted at /api/diagrams/shared.
 * No auth: the share token is the credential.
 */
const router = Router();

router.get(
  '/:token',
  validate(sharedTokenSchema as any),
  diagramsController.getShared
);
router.patch(
  '/:token',
  sharedDiagramWriteLimiter,
  validate(sharedUpdateSchema as any),
  diagramsController.updateShared
);
router.get(
  '/:token/presence',
  validate(sharedTokenSchema as any),
  diagramsController.presenceList
);
router.post(
  '/:token/presence',
  sharedDiagramWriteLimiter,
  validate(sharedPresenceSchema as any),
  diagramsController.presenceHeartbeat
);
router.post(
  '/:token/presence/leave',
  validate(sharedPresenceLeaveSchema as any),
  diagramsController.presenceLeave
);

export default router;
