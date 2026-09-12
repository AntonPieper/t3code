import {
  PreviewBrowserCdpEvent,
  type PreviewBrowserCdpInput,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { browserRecord, type BrowserPipePeer } from "./codexBrowserPipe.ts";

const decodeTabId = Schema.decodeUnknownSync(Schema.Int);
const decodeEvents = Schema.decodeUnknownSync(Schema.Array(PreviewBrowserCdpEvent));
const decodeAttachedTarget = Schema.decodeUnknownSync(
  Schema.Struct({
    sessionId: Schema.String,
    targetInfo: Schema.Struct({ targetId: Schema.String }),
  }),
);
const decodeDetachedTarget = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }));
const decodeTurnId = Schema.decodeUnknownSync(Schema.optional(Schema.String));

interface PreviewTab {
  readonly tabId: PreviewTabId;
  readonly url: string | null;
  readonly title: string | null;
}

export interface CodexBrowserHost {
  readonly list: () => Promise<ReadonlyArray<PreviewTab>>;
  readonly open: (
    visible: boolean,
    tabId?: PreviewTabId,
    signal?: AbortSignal,
  ) => Promise<PreviewTab>;
  readonly close: (tabId: PreviewTabId) => Promise<void>;
  readonly cdp: (
    tabId: PreviewTabId,
    input: PreviewBrowserCdpInput,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

interface AttachedTab {
  readonly leaseId: string;
  readonly peer: BrowserPipePeer;
  readonly controller: AbortController;
  readonly sessions: Map<string, string>;
}

/** Adapts only T3's registered native Codex thread. The original CUA runtime
 * owns JavaScript persistence, AX processing, actions, and image rendering. */
export function createCodexBrowserBackend(options: {
  readonly nativeThreadId: string;
  readonly version: string;
  readonly host: CodexBrowserHost;
}) {
  const { host } = options;
  const ids = new Map<number, PreviewTabId>();
  const attachments = new Map<number, AttachedTab>();
  let nextId = 1;
  let visible = true;
  let closed = false;
  let generation = 0;
  let activeTurnId: string | undefined;
  const endedTurns = new Set<string>();
  let leaseSequence = 0;
  let turnController = new AbortController();
  const transitions = new Map<number, Promise<unknown>>();
  const transition = <A>(id: number, work: () => Promise<A>): Promise<A> => {
    const previous = transitions.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    transitions.set(id, next);
    void next
      .finally(() => {
        if (transitions.get(id) === next) transitions.delete(id);
      })
      .catch(() => undefined);
    return next;
  };

  const serialize = (tab: PreviewTab) => {
    let id = [...ids].find(([, tabId]) => tabId === tab.tabId)?.[0];
    if (id === undefined) {
      id = nextId++;
      ids.set(id, tab.tabId);
    }
    return {
      id,
      providerTabId: tab.tabId,
      sessionControlled: true,
      title: tab.title ?? "",
      url: tab.url ?? "about:blank",
      active: true,
    };
  };
  const tabs = async () => (await host.list()).map(serialize);
  const owned = async (value: unknown) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw new Error("Invalid browser tab ID.");
    const tab = (await tabs()).find((entry) => entry.id === value);
    if (!tab) throw new Error("T3 Preview tab is closed or belongs to another session.");
    return tab;
  };
  const targetInfo = (tab: Awaited<ReturnType<typeof owned>>) => ({
    targetId: `t3-preview-tab:${tab.id}`,
    type: "page",
    title: tab.title,
    url: tab.url,
    attached: attachments.has(tab.id),
    canAccessOpener: false,
  });
  const detachNow = async (id: number, expectedLease?: string) => {
    const attachment = attachments.get(id);
    if (!attachment || (expectedLease !== undefined && attachment.leaseId !== expectedLease))
      return;
    attachment.controller.abort();
    try {
      const tabId = ids.get(id);
      if (tabId) await host.cdp(tabId, { kind: "detach", leaseId: attachment.leaseId });
    } finally {
      if (attachments.get(id) === attachment) attachments.delete(id);
      attachment.peer.notify("onCDPDetach", { tabId: id });
    }
  };
  const detach = (id: number, expectedLease?: string) =>
    transition(id, () => detachNow(id, expectedLease));
  const release = async (turnId?: string) => {
    if (turnId !== undefined && activeTurnId !== undefined && turnId !== activeTurnId) return;
    if (turnId !== undefined && endedTurns.has(turnId)) return;
    if (activeTurnId !== undefined) endedTurns.add(activeTurnId);
    if (turnId !== undefined) endedTurns.add(turnId);
    if (endedTurns.size > 128) endedTurns.delete(endedTurns.values().next().value!);
    activeTurnId = undefined;
    generation++;
    turnController.abort();
    turnController = new AbortController();
    // Attachment transitions remain registered until physical cleanup drains.
    await Promise.allSettled(
      [...new Set([...attachments.keys(), ...transitions.keys()])].map((id) => detach(id)),
    );
  };

  const attach = (value: unknown, peer: BrowserPipePeer) => {
    const id = decodeTabId(value);
    const startedGeneration = generation;
    const turnSignal = turnController.signal;
    return transition(id, async () => {
      const signal = AbortSignal.any([peer.signal, turnSignal]);
      signal.throwIfAborted();
      const tab = await owned(id);
      if (closed || startedGeneration !== generation)
        throw new Error("Browser turn ended during attachment.");
      const previous = attachments.get(id);
      if (previous?.peer === peer && !previous.controller.signal.aborted) return {};
      await detachNow(id);
      signal.throwIfAborted();
      const controller = new AbortController();
      const attachment: AttachedTab = {
        leaseId: `${options.nativeThreadId}:${++leaseSequence}`,
        peer,
        controller,
        sessions: new Map(),
      };
      attachments.set(id, attachment);
      const abort = () => {
        controller.abort();
        void detach(id, attachment.leaseId).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await host.cdp(tab.providerTabId, { kind: "attach", leaseId: attachment.leaseId }, signal);
        signal.throwIfAborted();
        if (closed || startedGeneration !== generation)
          throw new Error("Browser turn ended during attachment.");
      } catch (error) {
        signal.removeEventListener("abort", abort);
        await detachNow(id, attachment.leaseId);
        throw error;
      }
      const pump = async () => {
        try {
          while (!controller.signal.aborted) {
            const events = decodeEvents(
              await host.cdp(
                tab.providerTabId,
                { kind: "events", leaseId: attachment.leaseId },
                controller.signal,
              ),
            );
            if (controller.signal.aborted) return;
            for (const event of events) {
              if (event.method === "Target.attachedToTarget") {
                const attached = decodeAttachedTarget(event.params);
                attachment.sessions.set(attached.sessionId, attached.targetInfo.targetId);
              } else if (event.method === "Target.detachedFromTarget") {
                const detached = decodeDetachedTarget(event.params);
                attachment.sessions.delete(detached.sessionId);
              }
              peer.notify("onCDPEvent", {
                source: {
                  tabId: id,
                  ...(event.sessionId
                    ? {
                        sessionId: event.sessionId,
                        targetId: attachment.sessions.get(event.sessionId),
                      }
                    : {}),
                },
                method: event.method,
                params: event.params,
              });
            }
          }
        } finally {
          signal.removeEventListener("abort", abort);
        }
      };
      void pump()
        .catch(() => detach(id, attachment.leaseId))
        .catch(() => undefined);
      return {};
    });
  };

  const dispatch = async (
    method: string,
    params: Record<string, unknown>,
    peer: BrowserPipePeer,
  ): Promise<unknown> => {
    if (closed) throw new Error("T3 Codex browser session has ended.");
    if (method === "ping") return "pong";
    if (params.session_id !== options.nativeThreadId)
      throw new Error("This browser belongs to a different T3 Codex session.");
    const turnId = decodeTurnId(params.turn_id);
    if (method !== "turnEnded" && turnId !== undefined) {
      if (endedTurns.has(turnId)) throw new Error("This browser command belongs to an ended turn.");
      activeTurnId = turnId;
    }
    switch (method) {
      case "getInfo":
        return {
          name: "T3 Preview",
          version: options.version,
          type: "iab",
          metadata: { codexSessionId: options.nativeThreadId },
          apiSupportOverrides: {
            "Browser.user": false,
            "Browser.history": false,
            "Tab.markDeliverable": false,
            "Tab.markHandoff": false,
          },
          capabilities: {
            browser: [{ id: "visibility", description: "Show or hide T3 Preview." }],
            tab: [],
          },
        };
      case "getTabs":
        return tabs();
      case "createTab": {
        const signal = AbortSignal.any([peer.signal, turnController.signal]);
        const tab = await host.open(visible, undefined, signal);
        if (signal.aborted) {
          await host.close(tab.tabId);
          signal.throwIfAborted();
        }
        return serialize(tab);
      }
      case "nameSession":
        return {};
      case "turnEnded":
        await release(turnId);
        return {};
      case "attach":
        return attach(params.tabId, peer);
      case "detach": {
        const tab = await owned(params.tabId);
        const attachment = attachments.get(tab.id);
        if (attachment?.peer === peer) await detach(tab.id, attachment.leaseId);
        return {};
      }
      case "executeUnhandledCommand": {
        if (params.type === "browser_visibility_get") return { visible };
        if (params.type === "browser_visibility_set" && typeof params.visible === "boolean") {
          visible = params.visible;
          for (const tab of await tabs()) await host.open(visible, tab.providerTabId);
          return {};
        }
        throw new Error(`Unsupported T3 browser capability: ${String(params.type)}`);
      }
      case "moveMouse":
        await owned(params.tabId);
        return {}; // Codex's cursor overlay is optional; Input uses CDP.
      case "attachTarget": {
        const tab = await owned(params.tabId);
        if (params.targetId === targetInfo(tab).targetId) return {};
        const attachment = attachments.get(tab.id);
        const sessionId =
          attachment &&
          [...attachment.sessions].find(([, target]) => target === params.targetId)?.[0];
        if (!sessionId) throw new Error("Child target is not attached to this T3 Preview tab.");
        return { sessionId };
      }
      case "executeCdp": {
        const target = browserRecord(params.target);
        const tab = await owned(target.tabId);
        const command = typeof params.method === "string" ? params.method : "";
        const commandParams = browserRecord(params.commandParams ?? {});
        if (command === "Target.getTargets") return { targetInfos: (await tabs()).map(targetInfo) };
        if (command === "Target.getTargetInfo") {
          if (
            commandParams.targetId !== undefined &&
            commandParams.targetId !== targetInfo(tab).targetId
          )
            throw new Error("Target is not owned by this tab.");
          return { targetInfo: targetInfo(tab) };
        }
        if (command === "Target.closeTarget") {
          if (commandParams.targetId !== targetInfo(tab).targetId)
            throw new Error("Target is not owned by this tab.");
          const attachment = attachments.get(tab.id);
          if (!attachment || attachment.peer !== peer)
            throw new Error("Attach this T3 Preview tab before closing it.");
          await transition(tab.id, async () => {
            if (attachments.get(tab.id) !== attachment)
              throw new Error("Browser ownership changed before closing this tab.");
            await detachNow(tab.id, attachment.leaseId);
            await host.close(tab.providerTabId);
            ids.delete(tab.id);
          });
          return { success: true };
        }
        const attachment = attachments.get(tab.id);
        if (!attachment || attachment.peer !== peer)
          throw new Error("Attach this T3 Preview tab before sending CDP commands.");
        let sessionId: string | undefined;
        if (target.sessionId !== undefined) {
          if (typeof target.sessionId !== "string" || !attachment.sessions.has(target.sessionId))
            throw new Error("Unknown child session.");
          sessionId = target.sessionId;
        }
        if (target.targetId !== undefined && target.targetId !== targetInfo(tab).targetId) {
          const resolved = [...attachment.sessions].find(
            ([, value]) => value === target.targetId,
          )?.[0];
          if (!resolved || (sessionId !== undefined && sessionId !== resolved))
            throw new Error("Unknown or mismatched child target.");
          sessionId = resolved;
        }
        return host.cdp(
          tab.providerTabId,
          {
            kind: "send",
            leaseId: attachment.leaseId,
            method: command,
            commandParams,
            ...(sessionId ? { sessionId } : {}),
          },
          AbortSignal.any([peer.signal, attachment.controller.signal]),
        );
      }
      default:
        throw new Error(`No handler registered for method: ${method}`);
    }
  };
  return {
    dispatch,
    release,
    close: async () => {
      closed = true;
      await release();
    },
  };
}
