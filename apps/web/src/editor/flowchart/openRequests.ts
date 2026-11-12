/** Flowchart blocks (by block key) that should open their full-screen editor on first mount. */
export const flowOpenRequests = new Set<string>();
export const requestFlowOpen = (blockKey: string) => { flowOpenRequests.add(blockKey); };
