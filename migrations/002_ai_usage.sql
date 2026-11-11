-- Durable AI usage ledger (Phase 3). Safe to re-run on MySQL 8+.
CREATE TABLE IF NOT EXISTS tbl_ai_usage (
  id VARCHAR(255) PRIMARY KEY,
  userId VARCHAR(255) NOT NULL,
  feature VARCHAR(64) NOT NULL,
  credits INT NOT NULL DEFAULT 1,
  metaJson JSON NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_ai_usage_user_created (userId, createdAt),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (userId) REFERENCES tbl_user(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
