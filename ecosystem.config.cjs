module.exports = {
  apps: [
    {
      name: 'megabot',
      script: './dist/server.cjs',
      cwd: '/opt/megabot',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 20000,
      listen_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
