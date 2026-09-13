/**
 * Explorer links for the dashboard.
 *
 * Broker Tools (brokertools.info / stonkscan.io) is the house explorer for
 * Robinhood Chain: every user-facing TRANSACTION link on the site routes there
 * (user-directed 2026-09-13). Blockscout stays the API/read backend used by the
 * swarm's intel readers and the grader; address links keep the configured
 * explorer.
 */
export const BROKER_TOOLS_URL = "https://brokertools.info";

/** Broker Tools transaction page for a Robinhood Chain tx hash. */
export function txUrl(hash: string): string {
  return `${BROKER_TOOLS_URL}/tx/${hash}`;
}
