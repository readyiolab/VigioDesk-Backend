import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('pdf_saas'),
  DB_CONNECTION_LIMIT: z.coerce.number().default(5),
  REDIS_URL: z.string().url(),
  WEBREPORTS_HEALTH_PORT: z.coerce.number().default(5002),
  WEBREPORTS_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  WEBREPORTS_MAX_PAGES: z.coerce.number().int().min(1).max(200).default(50),
  WEBREPORTS_CRAWL_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(3),
  WEBREPORTS_POLITE_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(250),
  WEBREPORTS_SCAN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(30 * 60_000).default(10 * 60_000),
  WEBREPORTS_PAGE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(20_000),
  WEBREPORTS_MAX_BYTES: z.coerce.number().int().default(2 * 1024 * 1024),
  WEBREPORTS_LIGHTHOUSE_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  WEBREPORTS_SUMMARY_TIMEOUT_MS: z.coerce.number().int().default(12_000),
  PSI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  WEBREPORTS_SUMMARY_MODEL: z.string().default('claude-sonnet-4-5'),
  CHROME_PATH: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid webreports worker environment:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
