import { createDraftAutosave, type DraftRowMeta } from "../lib/use-draft-autosave";

/**
 * B923 ruling 3: draft autosave (POST/PATCH /drafts) is online-only now. When the interceptor refuses it
 * offline (`isOnlineRequired`), NOTHING typed may be lost: the builder's state is the source of truth, the
 * failed write is reported (logging only), and the very next save sends the LATEST payload, for both the
 * create and the update path.
 */
const META: DraftRowMeta = { kind: "ORDER", customerId: "cust-1", customerName: "Acme Retail" };
const offline = () =>
  Object.assign(new Error("You're offline. Connect and try again."), { isOnlineRequired: true });

describe("draft autosave when the write is refused offline", () => {
  afterEach(() => jest.useRealTimers());

  it("a refused CREATE is retried with the latest payload on the next save (nothing typed is lost)", async () => {
    const createDraft = jest
      .fn()
      .mockRejectedValueOnce(offline())
      .mockResolvedValue({ id: "draft-1" });
    const updateDraft = jest.fn().mockResolvedValue(undefined);
    const engine = createDraftAutosave({ createDraft, updateDraft });

    engine.update({ note: "first" }, META, true);
    // flush() surfaces the refused write to its caller (the timer path swallows and logs it)
    await expect(engine.flush()).rejects.toMatchObject({ isOnlineRequired: true });

    engine.update({ note: "first and more typed offline" }, META, true);
    await engine.flush();

    expect(createDraft).toHaveBeenCalledTimes(2);
    expect(createDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { note: "first and more typed offline" } }),
    );
  });

  it("a refused UPDATE is retried with the latest payload, never silently marked saved", async () => {
    const createDraft = jest.fn().mockResolvedValue({ id: "draft-1" });
    const updateDraft = jest.fn().mockRejectedValueOnce(offline()).mockResolvedValue(undefined);
    const engine = createDraftAutosave({ createDraft, updateDraft });

    engine.update({ v: 1 }, META, true);
    await engine.flush(); // create ok
    engine.update({ v: 2 }, META, true);
    await expect(engine.flush()).rejects.toMatchObject({ isOnlineRequired: true }); // update refused

    // same payload again (connectivity back, nothing new typed): it MUST still be sent
    engine.update({ v: 2 }, META, true);
    await engine.flush();

    expect(updateDraft).toHaveBeenCalledTimes(2);
    expect(updateDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "draft-1", payload: { v: 2 } }),
    );
  });
  it("row 699: flush() waits for a save still in flight (a PATCH paused offline), never resolving as if saved", async () => {
    jest.useFakeTimers();
    let settle!: { resolve: () => void; reject: (e: unknown) => void };
    const createDraft = jest.fn().mockResolvedValue({ id: "draft-1" });
    const updateDraft = jest.fn(
      () => new Promise<void>((resolve, reject) => (settle = { resolve, reject })),
    );
    const engine = createDraftAutosave({ createDraft, updateDraft, debounceMs: 900 });

    engine.update({ v: 1 }, META, true);
    await engine.flush(); // create ok
    engine.update({ v: 2 }, META, true);
    jest.advanceTimersByTime(900); // the debounced PATCH starts and hangs (TanStack pauses it offline)
    await Promise.resolve();
    expect(updateDraft).toHaveBeenCalledTimes(1);

    const onSaved = jest.fn();
    const flushed = engine.flush().then(onSaved);
    await Promise.resolve();
    await Promise.resolve();
    expect(onSaved).not.toHaveBeenCalled(); // the PATCH has not landed: nothing may say "saved"

    settle.reject(offline());
    await expect(flushed).rejects.toMatchObject({ isOnlineRequired: true });
    expect(onSaved).not.toHaveBeenCalled();
  });
});
