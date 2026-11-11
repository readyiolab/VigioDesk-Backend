# Database migrations

Vigodesk historically evolves schema at API boot via `ensureColumn` / `CREATE TABLE IF NOT EXISTS`.

## Going forward

1. Add numbered SQL files here (see `001_suite_asset.sql`, `002_ai_usage.sql`).
2. Apply manually or via your deploy hook:
   ```bash
   mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/001_suite_asset.sql
   mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < migrations/002_ai_usage.sql
   ```
3. Keep boot DDL in `api/src/lib/*Schema.ts` for greenfield installs until a dedicated migrator is adopted.

Boot DDL remains the source of truth for new environments; this folder records intentional, reviewable changes for production ops.

## Included migrations

| File | Purpose |
|------|---------|
| `001_suite_asset.sql` | Cross-product Asset Library (`tbl_suite_asset`) |
| `002_ai_usage.sql` | Durable AI credit ledger (`tbl_ai_usage`) |
| `003_webhook_outbound.sql` | Outbound webhook endpoints + delivery log |
