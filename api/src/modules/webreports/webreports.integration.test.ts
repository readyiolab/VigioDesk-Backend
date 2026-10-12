/**
 * MySQL integration for the website-audit tables.
 *
 * Skips unless WEBREPORTS_INTEGRATION=1. Requires the API database env
 * (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) that the API already uses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.WEBREPORTS_INTEGRATION === '1';

describe('webreport database integration', () => {
  it(
    'creates the webreport tables',
    { skip: enabled ? false : 'set WEBREPORTS_INTEGRATION=1 to run against MySQL' },
    async () => {
      const { getPool } = await import('../../lib/mysql');
      const { initializeWebReportSchema } = await import('../../lib/webreportSchema');
      const pool = getPool();
      const conn = await pool.getConnection();
      try {
        await initializeWebReportSchema(conn);
        const [rows] = await conn.query("SHOW TABLES LIKE 'tbl_webreport%'");
        const names = (rows as Record<string, string>[]).map((row) => Object.values(row)[0]);
        for (const table of ['tbl_webreport', 'tbl_webreport_page', 'tbl_webreport_check', 'tbl_webreport_perf']) {
          assert.ok(names.includes(table), table);
        }
      } finally {
        conn.release();
      }
    }
  );
});
