import { Request, Response } from 'express';
import { CloudService } from './cloud.service';
import { CloudProvider } from './cloud.types';

export class CloudController {
  static async getIntegrations(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const integrations = await CloudService.getUserIntegrations(userId);
      res.json({ status: 'success', data: integrations });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to fetch cloud integrations' });
    }
  }

  static async getOAuthUrl(req: Request, res: Response): Promise<void> {
    try {
      const provider = req.params.provider as CloudProvider;
      const state = req.query.state as string | undefined;
      const redirectUri = req.query.redirectUri as string | undefined;

      const data = CloudService.getOAuthUrl(provider, state, redirectUri);
      res.json({ status: 'success', data });
    } catch (err: any) {
      res.status(400).json({ status: 'error', message: err.message || 'Failed to generate OAuth URL' });
    }
  }

  static async connect(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const { provider, accountEmail, accessToken, refreshToken } = req.body;
      if (!provider || !accountEmail) {
        res.status(400).json({ status: 'error', message: 'provider and accountEmail are required' });
        return;
      }

      const integration = await CloudService.connectProvider(userId, {
        provider,
        accountEmail,
        accessToken,
        refreshToken,
      });

      res.json({ status: 'success', data: integration, message: `Successfully connected ${provider}` });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to connect cloud provider' });
    }
  }

  static async disconnect(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const { provider } = req.body;
      if (!provider) {
        res.status(400).json({ status: 'error', message: 'provider is required' });
        return;
      }

      await CloudService.disconnectProvider(userId, provider);
      res.json({ status: 'success', message: `Successfully disconnected ${provider}` });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to disconnect cloud provider' });
    }
  }

  static async getFiles(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const provider = (req.query.provider as CloudProvider) || 'gdrive';
      const folderId = req.query.folderId as string | undefined;
      const search = req.query.search as string | undefined;

      const files = await CloudService.getProviderFiles(userId, provider, {
        folderId,
        search,
      });
      res.json({ status: 'success', data: files });
    } catch (err: any) {
      res.status(400).json({ status: 'error', message: err.message || 'Failed to fetch cloud files' });
    }
  }

  static async downloadFile(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      const provider = req.params.provider as CloudProvider;
      const fileId = req.params.fileId;

      if (!provider || !fileId) {
        res.status(400).json({ status: 'error', message: 'provider and fileId parameters are required' });
        return;
      }

      const result = await CloudService.getFileDownloadUrlOrStream(userId, provider, fileId);

      if (result.url) {
        res.redirect(result.url);
        return;
      }

      if (result.buffer) {
        res.setHeader('Content-Type', result.contentType || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.setHeader('Content-Length', result.buffer.length);
        res.send(result.buffer);
        return;
      }

      res.status(404).json({ status: 'error', message: 'File stream not found' });
    } catch (err: any) {
      res.status(400).json({ status: 'error', message: err.message || 'Failed to download file' });
    }
  }

  static async sync(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return;
      }

      await CloudService.triggerWorkspaceSync(userId);
      res.json({ status: 'success', message: 'Workspace sync triggered successfully' });
    } catch (err: any) {
      res.status(500).json({ status: 'error', message: err.message || 'Failed to sync cloud workspace' });
    }
  }
}
