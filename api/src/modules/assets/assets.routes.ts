import { Router } from 'express';
import { authMiddleware, requireFullAccount } from '../../middleware/auth.middleware';
import { assetsService } from './assets.service';

const router = Router();
router.use(authMiddleware, requireFullAccount);

router.get('/', async (req, res, next) => {
  try {
    const assets = await assetsService.list(req.user.id, Number(req.query.limit) || 50);
    res.json({ assets });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const asset = await assetsService.create(req.user.id, req.body || {});
    res.status(201).json({ asset });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    res.json(await assetsService.remove(req.user.id, req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
