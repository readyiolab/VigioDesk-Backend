import { Request, Response, NextFunction } from 'express';
import { webreportsIntegrationsService } from './integrations.service';

export const webreportsIntegrationsController = {
  async status(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await webreportsIntegrationsService.status(req.user.id));
    } catch (err) {
      next(err);
    }
  },

  async authorize(req: Request, res: Response, next: NextFunction) {
    try {
      const provider = String(req.params.provider || '') as 'google_analytics' | 'google_search_console';
      res.status(200).json(await webreportsIntegrationsService.getAuthorizeUrl(req.user.id, provider));
    } catch (err) {
      next(err);
    }
  },

  async exchange(req: Request, res: Response, next: NextFunction) {
    try {
      const { code, state } = req.body as { code?: string; state?: string };
      res.status(200).json(await webreportsIntegrationsService.exchangeOAuthCode(req.user.id, String(code || ''), String(state || '')));
    } catch (err) {
      next(err);
    }
  },

  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const provider = String(req.params.provider || '') as 'google_analytics' | 'google_search_console' | 'backlinks';
      res.status(200).json(await webreportsIntegrationsService.disconnect(req.user.id, provider));
    } catch (err) {
      next(err);
    }
  },

  async saveBacklinks(req: Request, res: Response, next: NextFunction) {
    try {
      const { login, password } = req.body as { login?: string; password?: string };
      res.status(200).json(
        await webreportsIntegrationsService.saveBacklinksKey(req.user.id, String(login || ''), String(password || ''))
      );
    } catch (err) {
      next(err);
    }
  },

  async setProperty(req: Request, res: Response, next: NextFunction) {
    try {
      const provider = String(req.params.provider || '') as 'google_analytics' | 'google_search_console';
      const { propertyId, propertyLabel } = req.body as { propertyId?: string; propertyLabel?: string };
      res.status(200).json(
        await webreportsIntegrationsService.setProperty(
          req.user.id,
          provider,
          String(propertyId || ''),
          propertyLabel
        )
      );
    } catch (err) {
      next(err);
    }
  },

  async listProperties(req: Request, res: Response, next: NextFunction) {
    try {
      const provider = String(req.params.provider || '');
      if (provider === 'google_analytics') {
        res.status(200).json(await webreportsIntegrationsService.listGaProperties(req.user.id));
        return;
      }
      if (provider === 'google_search_console') {
        res.status(200).json(await webreportsIntegrationsService.listGscSites(req.user.id));
        return;
      }
      res.status(400).json({ status: 'error', message: 'Unsupported provider' });
    } catch (err) {
      next(err);
    }
  },

  async metrics(req: Request, res: Response, next: NextFunction) {
    try {
      const host = String(req.query.host || req.query.url || '');
      res.status(200).json(await webreportsIntegrationsService.metrics(req.user.id, host));
    } catch (err) {
      next(err);
    }
  },
};
