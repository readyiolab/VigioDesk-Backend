import type { PoolConnection } from 'mysql2/promise';
import { ensureIndex } from './ddl';

export async function initializeWebhookOutboundSchema(conn: PoolConnection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_webhook_endpoint (
      id VARCHAR(255) PRIMARY KEY,
      userId VARCHAR(255) NOT NULL,
      organizationId VARCHAR(255) NULL,
      url VARCHAR(2048) NOT NULL,
      secret VARCHAR(128) NOT NULL,
      eventsJson JSON NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_webhook_endpoint_user (userId, enabled),
      CONSTRAINT fk_webhook_endpoint_user FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_webhook_delivery (
      id VARCHAR(255) PRIMARY KEY,
      endpointId VARCHAR(255) NOT NULL,
      eventType VARCHAR(80) NOT NULL,
      payloadJson JSON NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      lastError VARCHAR(1000) NULL,
      responseStatus INT NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      deliveredAt DATETIME(3) NULL,
      INDEX idx_webhook_delivery_endpoint (endpointId, createdAt),
      CONSTRAINT fk_webhook_delivery_endpoint FOREIGN KEY (endpointId) REFERENCES tbl_webhook_endpoint(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await ensureIndex(conn, 'tbl_webhook_endpoint', 'idx_webhook_endpoint_user', 'userId, enabled');
  await ensureIndex(conn, 'tbl_webhook_delivery', 'idx_webhook_delivery_endpoint', 'endpointId, createdAt');
}
