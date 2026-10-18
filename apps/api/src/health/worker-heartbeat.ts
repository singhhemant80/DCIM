/** Redis key the worker refreshes every 15 s (expires after 90 s). */
export const WORKER_HEARTBEAT_KEY = 'cdcim:worker:heartbeat';
/** The worker's flow collector status (listening, unknown sources), refreshed with the heartbeat. */
export const FLOW_COLLECTOR_STATUS_KEY = 'cdcim:worker:flow-collector';
/** Live per-IP rates (last minute of flow records) for one organization, refreshed every 5 s by the worker. */
export const flowLiveKey = (orgId: string) => `cdcim:flows:live:${orgId}`;
/** Organizations with a hypervisor page open (score = until when, ms); the worker reads node loads every 5 s for them. */
export const VIRT_WATCH_KEY = 'cdcim:virt:watch';
/** Live node loads of one hypervisor integration (CPU %, memory), refreshed every 5 s while watched. */
export const virtLiveKey = (integrationId: string) => `cdcim:virt:live:${integrationId}`;
