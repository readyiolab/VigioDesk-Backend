import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
      : undefined,
});

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  timezone: 'Z',
  multipleStatements: false,
});

export async function queryAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function execute(sql: string, params: any[] = []) {
  const [result] = await pool.execute(sql, params);
  return result as { affectedRows: number };
}
