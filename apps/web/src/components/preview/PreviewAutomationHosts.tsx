"use client";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_AUTOMATION_OPERATIONS,
  PreviewAutomationSnapshotInput,
  PreviewAutomationResolveUrlInput,
  PreviewBrowserCdpInput,
  ThreadId,
  type EnvironmentId,
  type DesktopPreviewAutomationRequest,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationHost as PreviewAutomationHostState,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
  type PreviewRenderedViewportSize,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";

import {
  applyPreviewServerSnapshot,
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import {
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
  stopBrowserRecordingForUpload,
} from "~/browser/browserRecording";
import { resolveBrowserRecordingStopTarget } from "~/browser/browserRecordingScope";
import { uploadBrowserRecording } from "~/browser/browserRecordingUpload";
import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import {
  browserDefaultOpenProfileId,
  browserDefaultOpenViewport,
  resolveBrowserDefaults,
} from "~/browser/browserDefaults";
import { runBrowserViewportMutation } from "~/browser/browserViewportActions";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import {
  PreviewAutomationOperationError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import {
  explicitlySuppressesPreviewMiniPlayer,
  previewAutomationDefaultViewport,
  previewAutomationOpenNeedsOverlay,
  shouldAutoShowPreviewForAutomationUse,
  shouldOpenPreviewMiniPlayer,
} from "./previewAutomationOpenReadiness";
import {
  assertPreviewRuntimeCurrent,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";
import { getPreviewAutomationClientId } from "./previewAutomationClientId";
import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";
import { resolveHostWaitBudgetMs, waitForHostReadiness } from "./previewAutomationHostBudget";
import { isPreviewViewportReady } from "./previewViewportReadiness";
import { shouldRollbackPreviewViewport } from "./previewViewportRollback";

const PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS = 500;

const waitForPreviewPresentation = async (runtimeTabId: string): Promise<void> => {
  const deadline = Date.now() + PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
};

const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  deadlineMs: number,
): Promise<void> => {
  const waitBudgetMs = Math.max(0, deadlineMs - Date.now());
  const ready = await waitForHostReadiness(deadlineMs, async () => {
    const state = assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, {
      operation,
      requestId,
    });
    if (state.desktopByTabId[tabId] && previewBridge && isPreviewWebviewRendering(runtimeTabId)) {
      const status = await previewBridge.automation.status(runtimeTabId);
      return status.available;
    }
    return false;
  });
  if (ready) return;
  throw new PreviewAutomationOverlayTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    timeoutMs: waitBudgetMs,
  });
};

interface ExecutablePreviewWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const findPreviewWebview = (tabId: string): ExecutablePreviewWebview | null =>
  Array.from(document.querySelectorAll<ExecutablePreviewWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

const isPreviewWebviewRendering = (runtimeTabId: string): boolean => {
  const wrapper = findPreviewWebview(runtimeTabId)?.closest<HTMLElement>("[data-preview-viewport]");
  return wrapper?.getAttribute("data-preview-rendering") === "active";
};

const readWebviewViewport = async (
  webview: ExecutablePreviewWebview,
): Promise<PreviewRenderedViewportSize | null> => {
  const value = await webview.executeJavaScript(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { readonly width?: unknown; readonly height?: unknown };
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? { width, height }
    : null;
};

const readRenderedViewport = async (
  runtimeTabId: string,
): Promise<PreviewRenderedViewportSize | null> => {
  const webview = findPreviewWebview(runtimeTabId);
  if (!webview) return null;
  return await readWebviewViewport(webview);
};

const readDeclaredViewport = (
  webview: ExecutablePreviewWebview | null,
): PreviewRenderedViewportSize | null => {
  const width = Number(webview?.getAttribute("data-preview-css-width"));
  const height = Number(webview?.getAttribute("data-preview-css-height"));
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
};

const waitForRenderedViewport = async (
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  setting: PreviewViewportSetting,
  timeoutMs: number,
  context: {
    readonly requestId: PreviewAutomationRequest["requestId"];
    readonly operation: PreviewAutomationRequest["operation"];
    readonly environmentId: EnvironmentId;
    readonly threadId: PreviewAutomationRequest["threadId"];
  },
  signal?: AbortSignal,
): Promise<PreviewRenderedViewportSize> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    signal?.throwIfAborted();
    assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, context);
    try {
      const webview = findPreviewWebview(runtimeTabId);
      const appliedSettingKey = webview?.getAttribute("data-preview-viewport-key") ?? null;
      const declaredViewport = readDeclaredViewport(webview);
      const renderedViewport = webview ? await readWebviewViewport(webview) : null;
      signal?.throwIfAborted();
      if (
        renderedViewport &&
        isPreviewViewportReady({
          setting,
          appliedSettingKey,
          declaredViewport,
          renderedViewport,
        })
      ) {
        return renderedViewport;
      }
    } catch {
      // Registration and navigation can transiently replace the guest while
      // React applies the server snapshot. Retry until the operation deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationViewportTimeoutError({
    ...context,
    tabId,
    timeoutMs,
  });
};

const currentStatus = async (
  threadRef: ScopedThreadRef,
  requestedTabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const { snapshot, tabId } = resolvePreviewAutomationTarget(state, requestedTabId);
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, state.serverEpoch, tabId) : null;
  const visible = runtimeTabId
    ? (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible ?? false)
    : false;
  const renderingActive = runtimeTabId ? isPreviewWebviewRendering(runtimeTabId) : false;
  const viewportSetting = snapshot ? (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT) : undefined;
  const viewport =
    runtimeTabId && renderingActive
      ? await readRenderedViewport(runtimeTabId).catch(() => null)
      : null;
  const viewportStatus = {
    ...(viewportSetting === undefined ? {} : { viewportSetting }),
    ...(viewport === null ? {} : { viewport }),
  };
  if (runtimeTabId && tabId && previewBridge && state.desktopByTabId[tabId]) {
    const status = await previewBridge.automation.status(runtimeTabId);
    return { ...status, tabId, visible, ...viewportStatus };
  }
  const navStatus = snapshot?.navStatus;
  return {
    available: Boolean(previewBridge?.automation),
    visible,
    tabId,
    url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
    title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
    loading: navStatus?._tag === "Loading",
    ...viewportStatus,
  };
};

const decodeResolveUrlInput = Schema.decodeUnknownSync(PreviewAutomationResolveUrlInput);
const decodeBrowserCdpInput = Schema.decodeUnknownSync(PreviewBrowserCdpInput);
const decodeSnapshotInput = Schema.decodeUnknownSync(PreviewAutomationSnapshotInput);

const raiseAtomCommandFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]): never => {
  throw squashAtomCommandFailure(result);
};

const raisePreviewAutomationHostError = (
  error: PreviewAutomationRecordingNotActiveError,
): never => {
  throw error;
};

export function PreviewAutomationHosts() {
  const { environments } = useEnvironments();
  if (!isElectron || !previewBridge?.automation) return null;
  return (
    <>
      {/*
       * Host lifetime follows the desktop runtime's environment connections,
       * not the routed thread. This keeps background threads automatable and
       * lets the subscription runtime own reconnects for every saved target.
       */}
      {environments.map((environment) => (
        <PreviewAutomationHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

function PreviewAutomationHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const [automationClientId] = useState(getPreviewAutomationClientId);
  const syncOwnedEvents = useMemo(
    () =>
      Atom.make((get) => {
        get.subscribe(previewEnvironment.events({ environmentId, input: {} }), (result) => {
          if (!AsyncResult.isSuccess(result)) return;
          const event = result.value;
          const threadRef = { environmentId, threadId: ThreadId.make(event.threadId) };
          const known = readThreadPreviewState(threadRef).sessions[event.tabId] !== undefined;
          const owned =
            "snapshot" in event && event.snapshot.hostingClientId === automationClientId;
          if (known || owned) applyPreviewServerEvent(threadRef, event);
        });
      }),
    [automationClientId, environmentId],
  );
  useAtomValue(syncOwnedEvents);
  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      supportedOperations: PREVIEW_AUTOMATION_OPERATIONS.filter(
        (operation) =>
          operation !== "browserCdp" ||
          Boolean(previewBridge?.automation.run && previewBridge?.automation.cancel),
      ),
      supportsCancellation: Boolean(
        previewBridge?.automation.run && previewBridge?.automation.cancel,
      ),
    }),
    [automationClientId, environmentId],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialAutomationHost,
  });
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, {
    reportFailure: false,
  });
  const open = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const resize = useAtomCommand(previewEnvironment.resize, {
    reportFailure: false,
  });
  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "preview automation response",
  );
  const focusAutomationHost = useAtomCommand(
    previewEnvironment.focusAutomationHost,
    "preview automation host focus",
  );
  const [automationConnectionAtom] = useState(() => Atom.make<string | null>(null));
  const automationConnectionId = useAtomValue(automationConnectionAtom);
  const presentationSuppressedRuntimeTabsRef = useRef(new Map<string, Set<string>>());

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest, signal: AbortSignal): Promise<unknown> => {
      signal.throwIfAborted();
      // Session sync and tab creation consume the same budget as overlay registration.
      const hostDeadlineMs = Date.now() + resolveHostWaitBudgetMs(request.timeoutMs);
      const threadRef: ScopedThreadRef = {
        environmentId,
        threadId: request.threadId,
      };
      let tabId = request.tabId ?? null;
      let createdTabId: string | undefined;
      const browserActivity = { release: null as (() => void) | null };
      try {
        let state = readThreadPreviewState(threadRef);
        const needsSessionSync = needsPreviewAutomationSessionSync(state, request.tabId);
        if (needsSessionSync) {
          const listTarget = {
            environmentId,
            input: { threadId: request.threadId },
          } as const;
          registry.refresh(previewEnvironment.list(listTarget));
          const result = await listPreviews(listTarget);
          signal.throwIfAborted();
          if (result._tag === "Failure") {
            return raiseAtomCommandFailure(result);
          }
          reconcilePreviewServerSessions(threadRef, result.value);
          state = readThreadPreviewState(threadRef);
        }
        tabId = request.tabId ?? state.snapshot?.tabId ?? null;
        const unavailableTarget = {
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          bridgeAvailable: Boolean(previewBridge),
        };
        const requireReadyTab = async () => {
          signal.throwIfAborted();
          const bridge = previewBridge;
          const readyTabId = tabId;
          if (!bridge || !readyTabId) {
            throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
          }
          const readyState = readThreadPreviewState(threadRef);
          const hostingClientId = readyState.sessions[readyTabId]?.hostingClientId;
          if (hostingClientId != null && hostingClientId !== automationClientId)
            throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
          const runtimeTabId = previewRuntimeTabId(threadRef, readyState.serverEpoch, readyTabId);
          if (request.operation !== "open") {
            const { autoShowFloatingPreview } = await resolveBrowserDefaults();
            if (
              shouldAutoShowPreviewForAutomationUse({
                operation: request.operation,
                autoShowFloatingPreview,
                presentationSuppressed:
                  presentationSuppressedRuntimeTabsRef.current
                    .get(request.threadId)
                    ?.has(runtimeTabId) ?? false,
              })
            ) {
              usePreviewMiniPlayerStore
                .getState()
                .open(threadRef, browserMiniPlayerSource(readyTabId));
            }
          }
          browserActivity.release ??= acquireBrowserSurfaceActivity(runtimeTabId);
          await waitForDesktopOverlay(
            threadRef,
            request.requestId,
            readyTabId,
            runtimeTabId,
            request.operation,
            hostDeadlineMs,
          );
          signal.throwIfAborted();
          return {
            bridge,
            tabId: readyTabId,
            runtimeTabId,
          };
        };
        const runPhysicalRequest = async (
          runtimeTabId: string,
          command: DesktopPreviewAutomationRequest["command"],
          legacy: () => Promise<unknown>,
        ) => {
          signal.throwIfAborted();
          const automation = previewBridge?.automation;
          if (!automation?.run || !automation.cancel) return legacy();
          const cancel = () => {
            void automation.cancel?.(request.requestId);
          };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return await automation.run({
              requestId: request.requestId,
              tabId: runtimeTabId,
              command,
            });
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        };
        switch (request.operation) {
          case "status":
            return await currentStatus(threadRef, tabId);
          case "open": {
            const input = request.input as PreviewAutomationOpenInput;
            const resolvedInputUrl = input.url
              ? resolveBrowserNavigationTarget(environmentId, {
                  kind: "url",
                  url: input.url,
                }).resolvedUrl
              : undefined;
            let activeTabId = resolvePreviewAutomationOpenTab(
              state,
              request.tabId,
              input.reuseExistingTab ?? true,
            );
            let activeSnapshot = activeTabId
              ? (state.sessions[activeTabId] ?? state.snapshot ?? undefined)
              : undefined;
            const reusedExistingTab = activeTabId !== null;
            tabId = activeTabId;
            if (!activeTabId) {
              const defaults = await resolveBrowserDefaults();
              signal.throwIfAborted();
              const result = await open({
                environmentId,
                input: {
                  threadId: request.threadId,
                  hostingClientId: automationClientId,
                  ...(resolvedInputUrl ? { url: resolvedInputUrl } : {}),
                  // An agent that didn't state a size gets the user's
                  // configured default, same as a hand-opened tab.
                  viewport: browserDefaultOpenViewport(defaults),
                  profileId: browserDefaultOpenProfileId(defaults),
                },
              });
              if (result._tag === "Failure") {
                return raiseAtomCommandFailure(result);
              }
              const snapshot = result.value;
              createdTabId = snapshot.tabId;
              signal.throwIfAborted();
              applyPreviewServerSnapshot(threadRef, snapshot);
              activeTabId = snapshot.tabId;
              activeSnapshot = snapshot;
              tabId = activeTabId;
              // Establish the post-open revision before awaiting guest work. A
              // list requested before open must not remove the new tab later.
              const target = { environmentId, input: { threadId: request.threadId } };
              registry.refresh(previewEnvironment.list(target));
              const latest = await listPreviews(target);
              signal.throwIfAborted();
              if (latest._tag === "Failure") return raiseAtomCommandFailure(latest);
              reconcilePreviewServerSessions(threadRef, latest.value);
            }
            const activeRuntimeTabId = previewRuntimeTabId(
              threadRef,
              readThreadPreviewState(threadRef).serverEpoch,
              activeTabId,
            );
            signal.throwIfAborted();
            if (activeSnapshot) {
              const defaultViewport = previewAutomationDefaultViewport(
                reusedExistingTab,
                activeSnapshot,
              );
              if (defaultViewport) {
                const resizeResult = await runBrowserViewportMutation(
                  activeRuntimeTabId,
                  async () => {
                    signal.throwIfAborted();
                    assertPreviewRuntimeCurrent(
                      threadRef,
                      activeTabId,
                      activeRuntimeTabId,
                      request,
                    );
                    return await resize({
                      environmentId,
                      input: {
                        threadId: request.threadId,
                        tabId: activeTabId,
                        viewport: defaultViewport,
                      },
                    });
                  },
                  signal,
                );
                if (resizeResult._tag === "Failure") {
                  return raiseAtomCommandFailure(resizeResult);
                }
                activeSnapshot = resizeResult.value;
                updatePreviewServerSnapshot(threadRef, resizeResult.value);
              }
            }
            const shouldPresentPreview = shouldOpenPreviewMiniPlayer(
              input,
              (await resolveBrowserDefaults()).autoShowFloatingPreview,
            );
            signal.throwIfAborted();
            const explicitlySuppressed = explicitlySuppressesPreviewMiniPlayer(input);
            const suppressedTabs = presentationSuppressedRuntimeTabsRef.current.get(
              request.threadId,
            );
            if (explicitlySuppressed) {
              if (suppressedTabs) {
                suppressedTabs.add(activeRuntimeTabId);
              } else {
                presentationSuppressedRuntimeTabsRef.current.set(
                  request.threadId,
                  new Set([activeRuntimeTabId]),
                );
              }
              const miniPlayerTabId = selectThreadPreviewMiniPlayerTabId(
                usePreviewMiniPlayerStore.getState().byThreadKey,
                threadRef,
              );
              if (miniPlayerTabId === activeTabId) {
                usePreviewMiniPlayerStore.getState().close(threadRef);
              }
            } else if (shouldPresentPreview) {
              suppressedTabs?.delete(activeRuntimeTabId);
              if (suppressedTabs?.size === 0) {
                presentationSuppressedRuntimeTabsRef.current.delete(request.threadId);
              }
            }
            if (shouldPresentPreview) {
              usePreviewMiniPlayerStore
                .getState()
                .open(threadRef, browserMiniPlayerSource(activeTabId));
            }
            if (activeSnapshot && previewAutomationOpenNeedsOverlay(input, activeSnapshot)) {
              await requireReadyTab();
            }
            if (shouldPresentPreview) {
              // React commits the thread-bound surface asynchronously. Settle
              // briefly so active-thread opens report visible=true, without
              // turning a background thread's offscreen mini player into an
              // operation failure.
              await waitForPreviewPresentation(activeRuntimeTabId);
            }
            if (reusedExistingTab && resolvedInputUrl && previewBridge) {
              signal.throwIfAborted();
              assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
              await runPhysicalRequest(
                activeRuntimeTabId,
                { operation: "navigate", input: { url: resolvedInputUrl } },
                () => previewBridge!.navigate(activeRuntimeTabId, resolvedInputUrl),
              );
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                "load",
                request.timeoutMs,
              );
            }
            signal.throwIfAborted();
            return await currentStatus(threadRef, activeTabId);
          }
          case "resolveUrl": {
            await requireReadyTab();
            const input = decodeResolveUrlInput(request.input);
            const resolution = resolveBrowserNavigationTarget(environmentId, input.target);
            signal.throwIfAborted();
            return resolution;
          }
          case "navigate": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationNavigateInput;
            const resolution = resolveBrowserNavigationTarget(
              environmentId,
              input.target ?? {
                kind: "url",
                url: input.url!,
              },
            );
            signal.throwIfAborted();
            await runPhysicalRequest(
              ready.runtimeTabId,
              { operation: "navigate", input: { url: resolution.resolvedUrl } },
              () => ready.bridge.navigate(ready.runtimeTabId, resolution.resolvedUrl),
            );
            await waitForNavigationReadiness(
              threadRef,
              request.requestId,
              ready.tabId,
              ready.runtimeTabId,
              request.operation,
              input.readiness ?? "load",
              input.timeoutMs ?? request.timeoutMs,
            );
            return await currentStatus(threadRef, ready.tabId);
          }
          case "resize": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationResizeInput;
            const setting = resolvePreviewViewport(input);
            const applied = await runBrowserViewportMutation(
              ready.runtimeTabId,
              async () => {
                signal.throwIfAborted();
                const operationState = assertPreviewRuntimeCurrent(
                  threadRef,
                  ready.tabId,
                  ready.runtimeTabId,
                  request,
                );
                const previousSetting =
                  operationState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
                const result = await resize({
                  environmentId,
                  input: {
                    threadId: request.threadId,
                    tabId: ready.tabId,
                    viewport: setting,
                  },
                });
                if (result._tag === "Failure") {
                  return raiseAtomCommandFailure(result);
                }
                updatePreviewServerSnapshot(threadRef, result.value);
                return {
                  previousSetting,
                  serverEpoch: operationState.serverEpoch,
                };
              },
              signal,
            );
            let viewport: PreviewRenderedViewportSize;
            try {
              signal.throwIfAborted();
              viewport = await waitForRenderedViewport(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                setting,
                input.timeoutMs ?? request.timeoutMs,
                {
                  requestId: request.requestId,
                  operation: request.operation,
                  environmentId,
                  threadId: request.threadId,
                },
                signal,
              );
            } catch (cause) {
              await runBrowserViewportMutation(ready.runtimeTabId, async () => {
                const latestState = readThreadPreviewState(threadRef);
                const latestSetting =
                  latestState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
                if (
                  shouldRollbackPreviewViewport(
                    applied.previousSetting,
                    setting,
                    latestSetting,
                    applied.serverEpoch,
                    latestState.serverEpoch,
                  )
                ) {
                  const rollback = await resize({
                    environmentId,
                    input: {
                      threadId: request.threadId,
                      tabId: ready.tabId,
                      viewport: applied.previousSetting,
                    },
                  });
                  if (rollback._tag !== "Failure") {
                    updatePreviewServerSnapshot(threadRef, rollback.value);
                  }
                }
              });
              throw cause;
            }
            return {
              tabId: ready.tabId,
              setting,
              viewport,
            } satisfies PreviewAutomationResizeResult;
          }
          case "setColorScheme": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationSetColorSchemeInput;
            await ready.bridge.setColorScheme(ready.runtimeTabId, input.colorScheme);
            return {
              tabId: ready.tabId,
              colorScheme: input.colorScheme,
            } satisfies PreviewAutomationSetColorSchemeResult;
          }
          case "browserCdp": {
            const ready = await requireReadyTab();
            const input = decodeBrowserCdpInput(request.input);
            return await runPhysicalRequest(
              ready.runtimeTabId,
              { operation: "browserCdp", input },
              async () => {
                throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
              },
            );
          }
          case "snapshot": {
            const ready = await requireReadyTab();
            const input = decodeSnapshotInput(request.input ?? {});
            return await runPhysicalRequest(
              ready.runtimeTabId,
              { operation: "snapshot", input },
              () => ready.bridge.automation.snapshot(ready.runtimeTabId, input),
            );
          }
          case "click": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.click>[1];
            return await runPhysicalRequest(ready.runtimeTabId, { operation: "click", input }, () =>
              ready.bridge.automation.click(ready.runtimeTabId, input),
            );
          }
          case "type": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.type>[1];
            return await runPhysicalRequest(ready.runtimeTabId, { operation: "type", input }, () =>
              ready.bridge.automation.type(ready.runtimeTabId, input),
            );
          }
          case "press": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.press>[1];
            return await runPhysicalRequest(ready.runtimeTabId, { operation: "press", input }, () =>
              ready.bridge.automation.press(ready.runtimeTabId, input),
            );
          }
          case "scroll": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.scroll>[1];
            return await runPhysicalRequest(
              ready.runtimeTabId,
              { operation: "scroll", input },
              () => ready.bridge.automation.scroll(ready.runtimeTabId, input),
            );
          }
          case "evaluate": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.evaluate>[1];
            return await runPhysicalRequest(
              ready.runtimeTabId,
              { operation: "evaluate", input },
              () => ready.bridge.automation.evaluate(ready.runtimeTabId, input),
            );
          }
          case "waitFor": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.waitFor>[1];
            return await runPhysicalRequest(
              ready.runtimeTabId,
              { operation: "waitFor", input },
              () => ready.bridge.automation.waitFor(ready.runtimeTabId, input),
            );
          }
          case "recordingStart": {
            const ready = await requireReadyTab();
            const startedAt = await startBrowserRecording(
              ready.runtimeTabId,
              threadRef,
              ready.tabId,
            );
            if (signal.aborted) {
              await stopBrowserRecording(ready.runtimeTabId);
              signal.throwIfAborted();
            }
            return {
              tabId: ready.tabId,
              recording: true,
              startedAt,
            };
          }
          case "recordingStop": {
            const activeRecordings = readActiveBrowserRecordingTargets(threadRef);
            const activeTabIds = new Set(
              activeRecordings.map((recording) => recording.serverTabId),
            );
            const stopTabId = resolveBrowserRecordingStopTarget(
              activeTabIds,
              tabId,
              request.tabIdExplicit ? request.tabId : undefined,
            );
            tabId = stopTabId ?? tabId;
            const stopRuntimeTabId =
              activeRecordings.find((recording) => recording.serverTabId === stopTabId)
                ?.runtimeTabId ?? null;
            const transferToEnvironment =
              typeof request.input === "object" &&
              request.input !== null &&
              "transferToEnvironment" in request.input &&
              request.input.transferToEnvironment === true;
            const artifact = stopRuntimeTabId
              ? transferToEnvironment
                ? await stopBrowserRecordingForUpload(stopRuntimeTabId, (saved, blob) =>
                    uploadBrowserRecording(threadRef, saved, blob, hostDeadlineMs),
                  )
                : await stopBrowserRecording(stopRuntimeTabId)
              : null;
            if (!artifact || !stopTabId) {
              return raisePreviewAutomationHostError(
                new PreviewAutomationRecordingNotActiveError({
                  requestId: request.requestId,
                  environmentId,
                  threadId: request.threadId,
                  tabId,
                }),
              );
            }
            return {
              ...artifact,
              tabId: stopTabId,
            };
          }
        }
      } catch (cause) {
        if (createdTabId) {
          await close({
            environmentId,
            input: { threadId: request.threadId, tabId: createdTabId },
          });
          createdTabId = undefined;
        }
        throw PreviewAutomationOperationError.fromCause({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          cause,
        });
      } finally {
        if (signal.aborted && createdTabId) {
          await close({
            environmentId,
            input: { threadId: request.threadId, tabId: createdTabId },
          });
        }
        browserActivity.release?.();
      }
    },
    [automationClientId, close, environmentId, listPreviews, open, registry, resize],
  );
  const [requestHandlerAtom] = useState(() => Atom.make({ handle: handleRequest }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest });
  }, [handleRequest, setRequestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        clientId: automationClientId,
        connectionAtom: automationConnectionAtom,
        environmentId,
        requestHandlerAtom,
        respond: (response) =>
          respondToAutomation({
            environmentId,
            input: response,
          }),
        label: `preview:automation-host:${environmentId}:${automationClientId}`,
      }),
    [
      automationClientId,
      automationConnectionAtom,
      automationRequestsAtom,
      requestHandlerAtom,
      respondToAutomation,
      environmentId,
    ],
  );
  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!automationConnectionId) return;
      void focusAutomationHost({
        environmentId,
        input: {
          clientId: automationClientId,
          environmentId,
          connectionId: automationConnectionId,
          focused: document.hasFocus(),
        },
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [automationClientId, automationConnectionId, environmentId, focusAutomationHost]);

  return null;
}
