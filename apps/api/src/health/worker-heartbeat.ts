/** Redis key the worker refreshes every 15 s (expires after 90 s). */
export const WORKER_HEARTBEAT_KEY = 'cdcim:worker:heartbeat';
/** The worker's flow collector status (listening, unknown sources), refreshed with the heartbeat. */
export const FLOW_COLLECTOR_STATUS_KEY = 'cdcim:worker:flow-collector';
