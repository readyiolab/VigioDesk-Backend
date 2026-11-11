import { Router } from 'express';
import { CloudController } from './cloud.controller';
import { CloudService } from './cloud.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import type { CloudProvider } from './cloud.types';

const router = Router();

router.get('/integrations', authMiddleware, CloudController.getIntegrations);
router.get('/oauth/:provider', authMiddleware, CloudController.getOAuthUrl);
/** Exchange auth code → tokens → connect (preferred over inventing tokens). */
router.post('/oauth/:provider/exchange', authMiddleware, async (req, res) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ status: 'error', message: 'Unauthorized' });
      return;
    }
    const provider = req.params.provider as CloudProvider;
    const { code, redirectUri } = req.body || {};
    const integration = await CloudService.exchangeAndConnect(userId, provider, code, redirectUri);
    res.json({ status: 'success', data: integration });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
    res.status(status).json({ status: 'error', message: err.message || 'OAuth exchange failed' });
  }
});
router.post('/connect', authMiddleware, CloudController.connect);
router.post('/disconnect', authMiddleware, CloudController.disconnect);
router.get('/files', authMiddleware, CloudController.getFiles);
router.get('/download/:provider/:fileId', authMiddleware, CloudController.downloadFile);
router.post('/sync', authMiddleware, CloudController.sync);

export const cloudRoutes = router;
