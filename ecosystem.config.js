/**
 * Production PM2 layout for ~1k concurrent browser sessions:
 * - Multiple API instances (no Puppeteer inline)
 * - Dedicated PDF worker (+ product letter/sign workers)
 * - Dedicated WebReports worker
 *
 * Pool budget example (single MySQL, max_connections >= 200):
 *   API × 2 × DB_CONNECTION_LIMIT(15) + worker(15) + webreports(5) ≈ 50
 */
module.exports = {
  apps: [
    {
      name: "pdf-saas-api",
      script: "dist/api/src/index.js",
      cwd: "/var/www/pdf/pdf-backend/api",
      instances: 2,
      exec_mode: "cluster",
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "production",
        // Keep HTTP free of Chrome / sign-finalize CPU
        INLINE_LETTER_SIGN_WORKERS: "false",
        DB_CONNECTION_LIMIT: "15",
        DB_QUEUE_LIMIT: "200",
      },
    },
    {
      name: "pdf-saas-worker",
      script: "dist/worker/src/index.js",
      cwd: "/var/www/pdf/pdf-backend/worker",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "production",
        RUN_PRODUCT_WORKERS: "true",
        DB_CONNECTION_LIMIT: "15",
        DB_QUEUE_LIMIT: "200",
        // Concurrency caps — tune per host RAM/CPU
        LETTER_GENERATE_CONCURRENCY: "2",
        LETTER_SEND_CONCURRENCY: "1",
        SIGN_FINALIZE_CONCURRENCY: "2",
        HEAVY_QUEUE_CONCURRENCY: "2",
        LIGHT_QUEUE_CONCURRENCY: "10",
      },
    },
    {
      name: "pdf-saas-webreports",
      script: "dist/worker/src/webreports.worker.js",
      cwd: "/var/www/pdf/pdf-backend/worker",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "production",
        WEBREPORTS_HEALTH_PORT: 5002,
        WEBREPORTS_CONCURRENCY: 1,
        DB_CONNECTION_LIMIT: "5",
      },
    },
  ],
};
