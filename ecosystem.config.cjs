/**
 * PM2 config for running LAURA on a PC (Linux, macOS, Windows/WSL2) so she runs
 * whenever the machine is on, restarts on crash, and survives reboots.
 *
 * Two layouts are supported:
 *  - Daemon kit (recommended): scripts/daemon/laura-daemon.sh install. Releases
 *    live under $LAURA_HOME/releases/<sha>, `current` points at the live one,
 *    data sits in $LAURA_HOME/data and secrets in $LAURA_HOME/shared/.env.local.
 *    The kit's updater and watchdog run as PM2 apps next to LAURA.
 *  - Plain checkout: npm ci && npm run build && npx pm2 start ecosystem.config.cjs
 *    (data in ./data, no auto-update).
 *
 * Boot persistence: `npx pm2 save` then `npx pm2 startup` (Linux/macOS; WSL2
 * needs systemd enabled in /etc/wsl.conf) or pm2-windows-startup on Windows.
 */
const path = require("node:path");

/* The file may be loaded through the `current` symlink or its resolved
   releases/<sha> target depending on how PM2 requires it; both mean the kit. */
const viaSymlink = path.basename(__dirname) === "current";
const viaRelease = path.basename(path.dirname(__dirname)) === "releases";
const releaseLayout = viaSymlink || viaRelease;
const home = viaSymlink ? path.dirname(__dirname) : viaRelease ? path.resolve(__dirname, "..", "..") : __dirname;
const dataDir = releaseLayout ? path.join(home, "data") : path.join(__dirname, "data");
const cwd = releaseLayout ? path.join(home, "current") : __dirname;
const port = process.env.PORT || "4747";

const laura = {
  name: "laura",
  script: "node_modules/next/dist/bin/next",
  args: `start -p ${port}`,
  cwd,
  env: {
    NODE_ENV: "production",
    PORT: port,
    SWARM_DATA_DIR: dataDir,
    /* Enables /api/ops/restart (graceful exit; PM2 brings the process back). */
    LAURA_DAEMON: "1",
  },
  autorestart: true,
  restart_delay: 5000,
  max_restarts: 50,
  max_memory_restart: "2G",
  time: true,
  out_file: path.join(dataDir, "pm2-out.log"),
  error_file: path.join(dataDir, "pm2-err.log"),
};

const kitApp = (name, subcommand) => ({
  name,
  script: "scripts/daemon/laura-daemon.sh",
  args: subcommand,
  interpreter: "bash",
  cwd,
  env: { LAURA_HOME: home, PORT: port },
  autorestart: true,
  restart_delay: 10000,
  time: true,
  out_file: path.join(dataDir, `${name}.log`),
  error_file: path.join(dataDir, `${name}.log`),
});

module.exports = {
  apps: releaseLayout ? [laura, kitApp("laura-updater", "updater"), kitApp("laura-watchdog", "watchdog")] : [laura],
};
