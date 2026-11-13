import { Router } from 'express';
import { healthController } from './health.controller';

const router = Router();

router.get('/live', healthController.getLive);
router.get('/ready', healthController.getReady);
router.get('/metrics', healthController.getMetrics);
router.get('/', healthController.getHealth);

export default router;
