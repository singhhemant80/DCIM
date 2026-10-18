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
/** Remote-access checks (TCP to RDP 3389 / SSH 22) of one organization's running VMs, refreshed every 5 s while watched. */
export const virtAccessKey = (orgId: string) => `cdcim:virt:access:${orgId}`;
/** VMs with their manage page open (member = guest id, score = until when, ms); their use is read every 5 s. */
export const VIRT_GUEST_WATCH_KEY = 'cdcim:virt:guest-watch';
/** Live use of one VM (CPU, memory, disk, bandwidth), refreshed every 5 s while its page is open. */
export const virtGuestLiveKey = (guestId: string) => `cdcim:virt:guest:${guestId}`;
