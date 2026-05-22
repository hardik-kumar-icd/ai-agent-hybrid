// ============================================================================
// PM2 process definition for visor-agent
// ============================================================================
module.exports = {
  apps: [
    {
      name: 'visor-agent',
      cwd: '/var/www/visor-agent/server',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/var/log/visor-agent/error.log',
      out_file: '/var/log/visor-agent/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
      listen_timeout: 10000,
      restart_delay: 2000
    }
  ]
};
