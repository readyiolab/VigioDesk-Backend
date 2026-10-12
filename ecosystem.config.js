module.exports = {
  apps: [
    {
      name: "pdf-saas-api",
      script: "dist/api/src/index.js",
      cwd: "/var/www/pdf/pdf-backend/api",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "pdf-saas-worker",
      script: "dist/worker/src/index.js",
      cwd: "/var/www/pdf/pdf-backend/worker",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "pdf-saas-webreports",
      script: "dist/worker/src/webreports.worker.js",
      cwd: "/var/www/pdf/pdf-backend/worker",
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "production",
        WEBREPORTS_HEALTH_PORT: 5002,
        WEBREPORTS_CONCURRENCY: 1,
      },
    },
  ],
};
