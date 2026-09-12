import { PreviewTabId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createCodexBrowserBackend, type CodexBrowserHost } from "./codexBrowserBackend.ts";
import { browserPipeDecoder, browserPipeFrame, type BrowserPipePeer } from "./codexBrowserPipe.ts";

function fixture() {
  const tabs = [
    { tabId: PreviewTabId.make("tab_first"), title: "First", url: "https://example.com" },
  ];
  const eventRequests: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
  const host: CodexBrowserHost = {
    list: vi.fn(async () => [...tabs]),
    open: vi.fn(async (_visible, tabId) => {
      if (tabId) return tabs.find((tab) => tab.tabId === tabId)!;
      const tab = {
        tabId: PreviewTabId.make(`tab_${tabs.length + 1}`),
        title: "",
        url: "about:blank",
      };
      tabs.push(tab);
      return tab;
    }),
    close: vi.fn(async (tabId) => {
      tabs.splice(
        tabs.findIndex((tab) => tab.tabId === tabId),
        1,
      );
    }),
    cdp: vi.fn(async (_tabId, input, signal) => {
      if (input.kind !== "events") return { result: "cdp-result" };
      const pending = Promise.withResolvers<unknown>();
      eventRequests.push(pending);
      signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
      return pending.promise;
    }),
  };
  const controller = new AbortController();
  const peer: BrowserPipePeer = { signal: controller.signal, notify: vi.fn() };
  const backend = createCodexBrowserBackend({
    nativeThreadId: "native-t3-thread",
    version: "test",
    host,
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    backend.dispatch(
      method,
      {
        session_id: "native-t3-thread",
        turn_id: "turn-1",
        session_context: "live",
        ...params,
      },
      peer,
    );
  return { host, peer, backend, call, eventRequests, controller };
}

describe("Codex browser adapter", () => {
  it("drains and rejects an attach that overlaps turn release", async () => {
    const { host, backend, call } = fixture();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    vi.mocked(host.cdp).mockImplementation(async (_tab, input) => {
      if (input.kind === "attach") {
        entered.resolve();
        await proceed.promise;
      }
      return {};
    });
    const attaching = call("attach", { tabId: 1 });
    const rejected = expect(attaching).rejects.toThrow();
    await entered.promise;
    const releasing = backend.release();
    proceed.resolve();
    await rejected;
    await releasing;
    await expect(
      call("executeCdp", {
        target: { tabId: 1 },
        method: "Input.insertText",
        commandParams: { text: "after turn" },
      }),
    ).rejects.toThrow("ended turn");
    expect(host.cdp).toHaveBeenCalledWith("tab_first", {
      kind: "detach",
      leaseId: expect.any(String),
    });
    await backend.close();
  });

  it("finishes old peer cleanup before attaching a replacement", async () => {
    const { host, backend, call, controller } = fixture();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const original = vi.mocked(host.cdp).getMockImplementation()!;
    let physicalLease: string | undefined;
    vi.mocked(host.cdp).mockImplementation(async (tab, input, signal) => {
      if (input.kind === "attach") physicalLease = input.leaseId;
      if (input.kind === "detach" && physicalLease === input.leaseId) {
        entered.resolve();
        await proceed.promise;
        physicalLease = undefined;
      }
      if (input.kind === "send" && physicalLease !== input.leaseId)
        throw new Error("Stale physical lease");
      return original(tab, input, signal);
    });
    await call("attach", { tabId: 1 });
    controller.abort();
    await entered.promise;
    const next: BrowserPipePeer = { signal: new AbortController().signal, notify: vi.fn() };
    const attaching = backend.dispatch(
      "attach",
      { session_id: "native-t3-thread", tabId: 1 },
      next,
    );
    proceed.resolve();
    await attaching;
    await expect(
      backend.dispatch(
        "executeCdp",
        { session_id: "native-t3-thread", target: { tabId: 1 }, method: "Runtime.enable" },
        next,
      ),
    ).resolves.toEqual({ result: "cdp-result" });
    await backend.close();
  });
  it("ignores a superseded peer's detach and refuses its close", async () => {
    const { host, backend, call } = fixture();
    await call("attach", { tabId: 1 });
    const replacement: BrowserPipePeer = { signal: new AbortController().signal, notify: vi.fn() };
    await backend.dispatch("attach", { session_id: "native-t3-thread", tabId: 1 }, replacement);
    const calls = vi.mocked(host.cdp).mock.calls.length;
    await call("detach", { tabId: 1 });
    expect(vi.mocked(host.cdp).mock.calls).toHaveLength(calls);
    await expect(
      call("executeCdp", {
        target: { tabId: 1 },
        method: "Target.closeTarget",
        commandParams: { targetId: "t3-preview-tab:1" },
      }),
    ).rejects.toThrow("Attach");
    expect(host.close).not.toHaveBeenCalled();
    await expect(
      backend.dispatch(
        "executeCdp",
        { session_id: "native-t3-thread", target: { tabId: 1 }, method: "Runtime.enable" },
        replacement,
      ),
    ).resolves.toEqual({ result: "cdp-result" });
    await backend.close();
  });

  it("decodes fragmented native frames and multiple UTF-8 messages", () => {
    const messages: unknown[] = [];
    const receive = browserPipeDecoder((message) => messages.push(message));
    const first = browserPipeFrame({ title: "Grüße 🌍" });
    receive(first.subarray(0, 2));
    receive(first.subarray(2, 7));
    receive(Buffer.concat([first.subarray(7), browserPipeFrame({ id: 2 })]));
    expect(messages).toEqual([{ title: "Grüße 🌍" }, { id: 2 }]);
  });

  it("bounds frames before buffering a malicious payload", () => {
    const receive = browserPipeDecoder(() => undefined);
    expect(() => receive(Buffer.from([255, 255, 255, 255]))).toThrow("exceeds 16 MiB");
  });

  it("rejects unrelated native threads at discovery and command dispatch", async () => {
    const { call, host } = fixture();
    for (const method of ["getInfo", "getTabs", "createTab", "executeCdp"]) {
      await expect(call(method, { session_id: "another-native-thread" })).rejects.toThrow(
        "different T3 Codex session",
      );
    }
    expect(host.open).not.toHaveBeenCalled();
    expect(host.cdp).not.toHaveBeenCalled();
    expect(await call("getInfo")).toMatchObject({
      name: "T3 Preview",
      type: "iab",
      metadata: { codexSessionId: "native-t3-thread" },
    });
  });

  it("returns stable tab IDs and retains visibility intent for new tabs", async () => {
    const { call, host } = fixture();
    const first = await call("getTabs");
    expect(await call("getTabs")).toEqual(first);
    await call("executeUnhandledCommand", { type: "browser_visibility_set", visible: false });
    expect(await call("createTab")).toMatchObject({
      id: 2,
      providerTabId: "tab_2",
      url: "about:blank",
    });
    expect(host.open).toHaveBeenLastCalledWith(false, undefined, expect.any(AbortSignal));
    expect(await call("executeUnhandledCommand", { type: "browser_visibility_get" })).toEqual({
      visible: false,
    });
  });

  it("requires attachment, forwards raw CDP, and implements cached-expression fallback", async () => {
    const { call, host, backend } = fixture();
    const params = {
      target: { tabId: 1 },
      method: "Page.navigate",
      commandParams: { url: "https://example.org" },
    };
    await expect(call("executeCdp", params)).rejects.toThrow("Attach");
    await call("attach", { tabId: 1 });
    expect(await call("executeCdp", params)).toEqual({ result: "cdp-result" });
    expect(host.cdp).toHaveBeenCalledWith(
      "tab_first",
      {
        kind: "send",
        leaseId: expect.any(String),
        method: "Page.navigate",
        commandParams: params.commandParams,
      },
      expect.any(AbortSignal),
    );
    await expect(call("executeCdpWithCachedExpression", params)).rejects.toThrow(
      "No handler registered for method: executeCdpWithCachedExpression",
    );
    await backend.close();
  });

  it("does not expose or close unrelated Electron targets", async () => {
    const { call, host } = fixture();
    const target = { tabId: 1 };
    expect(await call("executeCdp", { target, method: "Target.getTargets" })).toMatchObject({
      targetInfos: [{ targetId: "t3-preview-tab:1" }],
    });
    await expect(
      call("executeCdp", {
        target,
        method: "Target.closeTarget",
        commandParams: { targetId: "electron-settings" },
      }),
    ).rejects.toThrow("not owned");
    expect(host.close).not.toHaveBeenCalled();
    await call("attach", { tabId: 1 });
    await call("executeCdp", {
      target,
      method: "Target.closeTarget",
      commandParams: { targetId: "t3-preview-tab:1" },
    });
    expect(host.close).toHaveBeenCalledWith("tab_first");
    await expect(call("attach", { tabId: 1 })).rejects.toThrow("closed or belongs");
  });

  it("delivers child CDP events, isolates sessions, and releases without closing tabs", async () => {
    const { call, host, backend, peer, eventRequests } = fixture();
    await call("attach", { tabId: 1 });
    const delivered = Promise.withResolvers<void>();
    vi.mocked(peer.notify).mockImplementation((method) => {
      if (method === "onCDPEvent") delivered.resolve();
    });
    eventRequests[0]!.resolve([
      {
        method: "Target.attachedToTarget",
        params: { sessionId: "child", targetInfo: { targetId: "frame" } },
      },
    ]);
    await delivered.promise;
    expect(peer.notify).toHaveBeenCalledWith(
      "onCDPEvent",
      expect.objectContaining({ source: { tabId: 1 } }),
    );
    await call("executeCdp", {
      target: { tabId: 1, sessionId: "child" },
      method: "Runtime.enable",
    });
    await expect(
      call("executeCdp", {
        target: { tabId: 1, sessionId: "other-child" },
        method: "Runtime.enable",
      }),
    ).rejects.toThrow("Unknown child session");
    await backend.release();
    expect(peer.notify).toHaveBeenCalledWith("onCDPDetach", { tabId: 1 });
    expect(host.cdp).toHaveBeenCalledWith("tab_first", {
      kind: "detach",
      leaseId: expect.any(String),
    });
    expect(host.close).not.toHaveBeenCalled();
    await backend.close();
    await expect(call("getInfo")).rejects.toThrow("ended");
  });
});
