/**
 * PM2 daemon config for running LAURA on a PC (Windows, macOS or Linux) so she
 * runs whenever the machine is on, restarts on crash, and survives reboots.
 *
 *   npm ci && npm run build
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 save
 *   # boot persistence: `npx pm2 startup` (mac/linux) or
 *   #                   `npm i -g pm2-windows-startup && pm2-startup install`
 *
 * Secrets stay in .env.local next to this file (Next loads it at start).
 * Runs the Next binary through node directly so the same file works on every OS.
 */
module.exports = {
  apps: [
    {
      name: "laura",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 4747",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: "4747",
      },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      max_memory_restart: "2G",
      time: true,
      out_file: "data/pm2-out.log",
      error_file: "data/pm2-err.log",
    },
  ],
};
