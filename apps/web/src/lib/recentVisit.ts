import { ApiError } from "./api";

/**
 * A mounted document records one successful visit. Temporary failures retry
 * with bounded backoff; a denied request refreshes permission metadata instead.
 * start/stop can alternate (including React StrictMode) without duplicate writes.
 */
export function createVisitRecorder(record: () => Promise<void>, onRecorded: () => void, onDenied: () => void) {
  let active = false;
  let inFlight = false;
  let done = false;
  let notified = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const notify = () => {
    if (done && !notified) {
      notified = true;
      onRecorded();
    }
  };
  const attempt = async () => {
    if (!active || inFlight || done) return;
    inFlight = true;
    try {
      await record();
      done = true;
      notify();
    } catch (error) {
      if (!active) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        onDenied();
      } else {
        const delay = Math.min(1000 * 2 ** Math.min(attempts++, 5), 30_000);
        timer = setTimeout(() => { timer = undefined; void attempt(); }, delay);
      }
    } finally {
      inFlight = false;
    }
  };
  return {
    start() { active = true; if (done) notify(); else void attempt(); },
    stop() { active = false; if (timer !== undefined) clearTimeout(timer); timer = undefined; },
  };
}
