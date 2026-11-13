-- Performance indexes for ~1k concurrent sessions (hot list/poll paths).
-- Idempotent-ish: ignore duplicate-key errors if indexes already exist from boot DDL.

-- Jobs: user + status + createdAt (active jobs / History)
CREATE INDEX idx_job_user_status_created ON tbl_job (userId, status, createdAt);

-- Letters: batch status polls and brand/template lists
CREATE INDEX idx_letter_batch_org_status ON tbl_letter_batch (organizationId, status, updatedAt);
CREATE INDEX idx_letter_brand_org ON tbl_letter_brand_profile (organizationId, updatedAt);
CREATE INDEX idx_letter_template_org ON tbl_letter_template (organizationId, updatedAt);
CREATE INDEX idx_letter_emp_batch_validation ON tbl_letter_batch_employee (batchId, validationStatus);

-- Diagrams folders list (column may be missing on older installs)
ALTER TABLE tbl_diagram_folder
  ADD COLUMN updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER createdAt;
CREATE INDEX idx_diagram_folder_org_updated ON tbl_diagram_folder (organizationId, updatedAt);
