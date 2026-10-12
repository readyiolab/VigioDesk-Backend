import type { PoolConnection } from 'mysql2/promise';
import { ensureColumn, ensureIndex } from './ddl';

export async function initializeWebReportSchema(conn: PoolConnection): Promise<void> {
  await ensureColumn(conn, 'tbl_user', 'dailyWebReportsUsed', 'INT NOT NULL DEFAULT 0');
  await ensureColumn(
    conn,
    'tbl_user',
    'dailyWebReportsResetAt',
    'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)'
  );

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_webreport (
      id VARCHAR(255) PRIMARY KEY,
      userId VARCHAR(255) NOT NULL,
      url VARCHAR(2048) NOT NULL,
      normalizedHost VARCHAR(255) NOT NULL,
      normalizedUrl VARCHAR(2048) NOT NULL,
      urlHash CHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      stage VARCHAR(40) NULL,
      progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
      overallScore TINYINT UNSIGNED NULL,
      mobileScore TINYINT UNSIGNED NULL,
      desktopScore TINYINT UNSIGNED NULL,
      seoScore TINYINT UNSIGNED NULL,
      aiScore TINYINT UNSIGNED NULL,
      summaryHeadline VARCHAR(240) NULL,
      summaryText VARCHAR(2000) NULL,
      shareToken VARCHAR(64) NULL,
      errorMessage VARCHAR(500) NULL,
      pagesCrawled INT NOT NULL DEFAULT 0,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      startedAt DATETIME(3) NULL,
      completedAt DATETIME(3) NULL,
      jobGeneration INT NOT NULL DEFAULT 1,
      activeJobId VARCHAR(128) NULL,
      enqueuedAt DATETIME(3) NULL,
      completenessJson JSON NULL,
      topFixesJson JSON NULL,
      detailJson JSON NULL,
      checkpointJson JSON NULL,
      scoringVersion VARCHAR(64) NOT NULL,
      contractVersion INT NOT NULL DEFAULT 1,
      maxPages INT NOT NULL DEFAULT 50,
      UNIQUE KEY uq_webreport_share (shareToken),
      INDEX idx_webreport_user_created (userId, createdAt),
      INDEX idx_webreport_cache (userId, urlHash, createdAt),
      INDEX idx_webreport_status (status, startedAt),
      CONSTRAINT fk_webreport_user FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_webreport_page (
      id VARCHAR(255) PRIMARY KEY,
      reportId VARCHAR(255) NOT NULL,
      url VARCHAR(2048) NOT NULL,
      statusCode INT NULL,
      title VARCHAR(500) NULL,
      metaDescription VARCHAR(500) NULL,
      canonical VARCHAR(2048) NULL,
      h1Count INT NOT NULL DEFAULT 0,
      wordCount INT NOT NULL DEFAULT 0,
      responseMs INT NULL,
      sizeBytes INT NULL,
      schemaTypes JSON NULL,
      issues JSON NULL,
      diagnostics JSON NULL,
      INDEX idx_webreport_page_report (reportId),
      CONSTRAINT fk_webreport_page FOREIGN KEY (reportId) REFERENCES tbl_webreport(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_webreport_check (
      id VARCHAR(255) PRIMARY KEY,
      reportId VARCHAR(255) NOT NULL,
      category VARCHAR(32) NOT NULL,
      checkId VARCHAR(80) NOT NULL,
      status VARCHAR(20) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      title VARCHAR(240) NOT NULL,
      description VARCHAR(2000) NOT NULL,
      affectedCount INT NOT NULL DEFAULT 0,
      affectedUrls JSON NULL,
      fix TEXT NOT NULL,
      impact VARCHAR(20) NOT NULL,
      effort VARCHAR(20) NOT NULL,
      INDEX idx_webreport_check_report (reportId, checkId),
      CONSTRAINT fk_webreport_check FOREIGN KEY (reportId) REFERENCES tbl_webreport(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS tbl_webreport_perf (
      id VARCHAR(255) PRIMARY KEY,
      reportId VARCHAR(255) NOT NULL,
      device VARCHAR(16) NOT NULL,
      pageUrl VARCHAR(2048) NULL,
      score TINYINT UNSIGNED NULL,
      lcpMs INT NULL,
      inpMs INT NULL,
      cls DOUBLE NULL,
      fcpMs INT NULL,
      ttfbMs INT NULL,
      tbtMs INT NULL,
      bytes INT NULL,
      opportunities JSON NULL,
      fieldData JSON NULL,
      INDEX idx_webreport_perf_report (reportId, device),
      CONSTRAINT fk_webreport_perf FOREIGN KEY (reportId) REFERENCES tbl_webreport(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await ensureIndex(conn, 'tbl_webreport', 'idx_webreport_user_created', 'userId, createdAt');
  await ensureIndex(conn, 'tbl_webreport', 'idx_webreport_status', 'status, startedAt');
  await ensureIndex(conn, 'tbl_webreport_page', 'idx_webreport_page_report', 'reportId');
  await ensureIndex(conn, 'tbl_webreport_check', 'idx_webreport_check_report', 'reportId, checkId');
  await ensureIndex(conn, 'tbl_webreport_perf', 'idx_webreport_perf_report', 'reportId, device');
}
