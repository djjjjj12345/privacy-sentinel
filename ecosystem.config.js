/**
 * PM2 进程配置（生产）
 * ---------------------------------------------------------------
 * 用法：
 *   pm2 start ecosystem.config.js
 *   pm2 reload ecosystem.config.js   # 发布时用 reload，不是 restart
 *
 * 设计要点：
 *   - exec_mode: fork + instances: 1。SQLite 是单写者，开 cluster 多实例会争锁；
 *     要上多实例请先切 DB_DRIVER=mysql + REDIS_URL。
 *   - kill_timeout 必须 ≥ server.js 里的 25s 排空窗口，否则 PM2 会在应用
 *     还没处理完在途请求时直接 SIGKILL，用户看到连接被重置。
 *   - max_memory_restart 兜底：单请求 JSON 上限 45MB，解析峰值可能上百 MB，
 *     内存泄漏或并发高峰时让 PM2 主动重启，优于被系统 OOM Killer 杀掉。
 */
module.exports = {
  apps: [
    {
      name: 'privacy-sentinel',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      max_memory_restart: '700M',
      kill_timeout: 30000,
      listen_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: '/var/log/privacy-sentinel/out.log',
      error_file: '/var/log/privacy-sentinel/err.log',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
      },
    },
  ],
};
