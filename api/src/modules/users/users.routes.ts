import { Router } from 'express';
import { usersController } from './users.controller';
import { authMiddleware } from '../../middleware/auth.middleware';

const router = Router();

router.get('/me', authMiddleware, usersController.getMe);
router.get('/me/usage', authMiddleware, usersController.getUsage);

export default router;
