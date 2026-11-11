import type { PoolConnection } from 'mysql2/promise';
import { ensureIndex } from './ddl';

export async function initializeAssetLibrarySchema(conn: PoolConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_suite_asset (
      id VARCHAR(255) PRIMARY KEY,
      userId VARCHAR(255) NOT NULL,
      organizationId VARCHAR(255) NULL,
      title VARCHAR(255) NOT NULL,
      sourceModule VARCHAR(40) NOT NULL,
      sourceId VARCHAR(255) NULL,
      mimeType VARCHAR(120) NOT NULL DEFAULT 'application/pdf',
      storageKey VARCHAR(512) NOT NULL,
      sizeBytes INT NOT NULL DEFAULT 0,
      metaJson JSON NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_suite_asset_user (userId, createdAt),
      INDEX idx_suite_asset_org (organizationId, createdAt),
      CONSTRAINT fk_suite_asset_user FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  await ensureIndex(conn, 'tbl_suite_asset', 'idx_suite_asset_user', 'userId, createdAt');
}
