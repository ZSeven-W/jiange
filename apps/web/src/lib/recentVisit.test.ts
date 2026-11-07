import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { createVisitRecorder } from "./recentVisit";

afterEach(() => vi.useRealTimers());

describe("recent visit recording", () => {
  it("sends one request across a StrictMode stop/start and notifies once", async () => {
    let finish!: () => void;
    const record = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const recorded = vi.fn();
    const recorder = createVisitRecorder(record, recorded, vi.fn());
    recorder.start();
    recorder.stop();
    recorder.start();
    expect(record).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    expect(recorded).toHaveBeenCalledTimes(1);
    recorder.stop();
    recorder.start();
    expect(record).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  it("invalidates recent history even if the user leaves before the request finishes", async () => {
    let finish!: () => void;
    const recorded = vi.fn();
    const recorder = createVisitRecorder(() => new Promise<void>((resolve) => { finish = resolve; }), recorded, vi.fn());
    recorder.start();
    recorder.stop();
    finish();
    await Promise.resolve();
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  it("retries temporary errors and cancels retries when leaving the document", async () => {
    vi.useFakeTimers();
    const record = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(undefined);
    const recorded = vi.fn();
    const recorder = createVisitRecorder(record, recorded, vi.fn());
    recorder.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(record).toHaveBeenCalledTimes(2);
    expect(recorded).toHaveBeenCalledTimes(1);
    recorder.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(record).toHaveBeenCalledTimes(2);

    const failing = vi.fn().mockRejectedValue(new TypeError("offline"));
    const other = createVisitRecorder(failing, vi.fn(), vi.fn());
    other.start();
    await vi.advanceTimersByTimeAsync(0);
    other.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("does not retry a denied visit and asks to refresh authorization", async () => {
    vi.useFakeTimers();
    const record = vi.fn().mockRejectedValue(new ApiError(404, "not_found", "denied"));
    const denied = vi.fn();
    const recorder = createVisitRecorder(record, vi.fn(), denied);
    recorder.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(record).toHaveBeenCalledTimes(1);
    expect(denied).toHaveBeenCalledTimes(1);
    recorder.stop();
  });
});
