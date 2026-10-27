import { Request, Response, NextFunction } from 'express';
import { webreportsService } from './webreports.service';

export const webreportsController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await webreportsService.create(req.user.id, req.user.plan, req.body);
      res.status(result.statusCode).json({ cached: result.cached, report: result.report });
    } catch (err) {
      next(err);
    }
  },

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Number(req.query.limit);
      const offset = Number(req.query.offset);
      res.status(200).json(await webreportsService.list(req.user.id, limit, offset));
    } catch (err) {
      next(err);
    }
  },

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ report: await webreportsService.get(req.user.id, req.params.id) });
    } catch (err) {
      next(err);
    }
  },

  async rescan(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await webreportsService.rescan(req.user.id, req.user.plan, req.params.id, req.body?.maxPages);
      res.status(result.statusCode).json({ report: result.report });
    } catch (err) {
      next(err);
    }
  },

  async share(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await webreportsService.share(req.user.id, req.params.id));
    } catch (err) {
      next(err);
    }
  },

  async revoke(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await webreportsService.revoke(req.user.id, req.params.id));
    } catch (err) {
      next(err);
    }
  },

  async updateBranding(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await webreportsService.updateBranding(req.user.id, req.params.id, req.body));
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json(await webreportsService.remove(req.user.id, req.params.id));
    } catch (err) {
      next(err);
    }
  },
};

export const publicWebReportsController = {
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ report: await webreportsService.getPublic(req.params.token) });
    } catch (err) {
      next(err);
    }
  },
};
