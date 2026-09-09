import { startScheduler } from "@/lib/swarm/scheduler";

/**
 * Standalone autopilot process for deployments that run the console and the
 * scheduler separately. When the console itself runs with SWARM_AUTOPILOT unset
 * or "1", it already hosts the same loop in-process (see src/instrumentation.ts),
 * so run this only if you set SWARM_AUTOPILOT=0 on the web process.
 */
startScheduler();
