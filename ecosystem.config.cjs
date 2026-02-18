const path = require('path')

module.exports = {
  apps: [
    {
      name: 'waves-alerts-bot',
      cwd: path.resolve(__dirname),
      script: 'npm',
      args: 'start',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '300M',
      time: true,
    },
  ],
}
