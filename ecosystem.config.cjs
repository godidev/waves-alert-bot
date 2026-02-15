module.exports = {
  apps: [
    {
      name: 'waves-alerts-bot',
      cwd: '/home/clobot/.openclaw/workspace/waves-alerts-bot',
      script: 'npm',
      args: 'start',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
    },
  ],
}
