import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';

export const assetsService = {
  async list(userId: string, limit = 50) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    return db.queryAll(
      `SELECT id, userId, organizationId, title, sourceModule, sourceId, mimeType, storageKey, sizeBytes, createdAt
         FROM tbl_suite_asset
        WHERE userId = ?
        ORDER BY createdAt DESC
        LIMIT ${safeLimit}`,
      [userId]
    );
  },

  async create(
    userId: string,
    input: {
      title: string;
      sourceModule: string;
      sourceId?: string;
      mimeType?: string;
      storageKey: string;
      sizeBytes?: number;
      organizationId?: string;
      meta?: Record<string, unknown>;
    }
  ) {
    if (!input.title?.trim() || !input.storageKey?.trim() || !input.sourceModule?.trim()) {
      throw new AppError('title, sourceModule, and storageKey are required', 400);
    }
    const id = crypto.randomUUID();
    await db.insert('tbl_suite_asset', {
      id,
      userId,
      organizationId: input.organizationId || null,
      title: input.title.trim().slice(0, 255),
      sourceModule: input.sourceModule.slice(0, 40),
      sourceId: input.sourceId || null,
      mimeType: input.mimeType || 'application/pdf',
      storageKey: input.storageKey,
      sizeBytes: Number(input.sizeBytes) || 0,
      metaJson: input.meta ? JSON.stringify(input.meta) : null,
    });
    return db.select('tbl_suite_asset', '*', 'id = ?', [id]);
  },

  async remove(userId: string, assetId: string) {
    const result = await db.delete('tbl_suite_asset', 'id = ? AND userId = ?', [assetId, userId]);
    if (!result.affected_rows) throw new AppError('Asset not found', 404);
    return { deleted: true };
  },
};
