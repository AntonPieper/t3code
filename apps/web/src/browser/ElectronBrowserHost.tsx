"use client";

import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { getPreviewAutomationClientId } from "~/components/preview/previewAutomationClientId";
import { useAtomCommand } from "~/state/use-atom-command";
import { previewEnvironment } from "~/state/preview";
import { updatePreviewServerSnapshot } from "~/previewStateStore";
import { useTheme } from "~/hooks/useTheme";
import { useActivePreviewSessions } from "~/previewStateStore";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { acquireDesktopTab } from "./desktopTabLifetime";
import { previewPhysicalUrl, resolvePreviewNavigation } from "./previewPortGateway";

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.sessions).map((snapshot) => ({
              threadRef,
              snapshot,
              runtimeTabId: previewRuntimeTabId(
                threadRef,
                previewState.serverEpoch,
                snapshot.tabId,
              ),
              pictureInPicture:
                previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
              zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
            }))
          : [];
      }),
    [previewByThreadKey],
  );

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor }) => {
        const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
        return (
          <OwnedBrowserWebview
            snapshot={snapshot}
            key={runtimeTabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            runtimeTabId={runtimeTabId}
            initialUrl={url}
            viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
            pictureInPicture={pictureInPicture}
            profileId={snapshot.profileId}
            zoomFactor={zoomFactor}
          />
        );
      })}
    </div>
  );
}

function OwnedBrowserWebview(
  props: React.ComponentProps<typeof HostedBrowserWebview> & {
    readonly snapshot: PreviewSessionSnapshot;
    readonly threadRef: ScopedThreadRef;
  },
) {
  const claim = useAtomCommand(previewEnvironment.claimHost, { reportFailure: false });
  const clientId = getPreviewAutomationClientId();
  const { hostingClientId } = props.snapshot;
  const { environmentId, threadId } = props.threadRef;
  const tabId = props.snapshot.tabId;
  useEffect(() => {
    if (hostingClientId !== null) return;
    let disposed = false;
    void claim({ environmentId, input: { threadId, tabId, clientId } }).then((result) => {
      if (!disposed && result._tag !== "Failure")
        updatePreviewServerSnapshot({ environmentId, threadId }, result.value);
    });
    return () => {
      disposed = true;
    };
  }, [claim, clientId, environmentId, threadId, tabId, hostingClientId]);
  if (hostingClientId !== undefined && hostingClientId !== clientId) return null;
  return <PreparedBrowserWebview {...props} />;
}

function PreparedBrowserWebview(
  props: React.ComponentProps<typeof HostedBrowserWebview> & {
    readonly snapshot: PreviewSessionSnapshot;
  },
) {
  // The key is the runtime tab lifetime. Later navigation updates must not remount its guest.
  const [initial] = useState(() => props);
  const [prepared, setPrepared] = useState(() => !initial.snapshot.environmentPort);
  const report = useAtomCommand(previewEnvironment.reportStatus, { reportFailure: false });
  useEffect(() => {
    if (!initial.snapshot.environmentPort || !initial.initialUrl) return;
    let disposed = false;
    const lease = acquireDesktopTab(initial.runtimeTabId);
    void lease.ready
      .then(async () => {
        if (disposed) return;
        const url = new URL(initial.initialUrl!);
        await resolvePreviewNavigation(initial.threadRef.environmentId, initial.runtimeTabId, {
          kind: "environment-port",
          ...initial.snapshot.environmentPort!,
          path: `${url.pathname}${url.search}${url.hash}`,
        });
        if (!disposed) setPrepared(true);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        void report({
          environmentId: initial.threadRef.environmentId,
          input: {
            threadId: initial.threadRef.threadId,
            tabId: initial.tabId,
            navStatus: {
              _tag: "LoadFailed",
              url: initial.initialUrl!,
              title: "",
              code: -2,
              description:
                cause instanceof Error ? cause.message : "Preview routing is unavailable.",
            },
            environmentPort: initial.snapshot.environmentPort,
            canGoBack: false,
            canGoForward: false,
          },
        });
      });
    return () => {
      disposed = true;
      lease.release();
    };
  }, [initial, report]);
  if (!prepared) return null;
  return (
    <HostedBrowserWebview
      {...props}
      initialUrl={
        props.initialUrl === null ? null : previewPhysicalUrl(props.runtimeTabId, props.initialUrl)
      }
    />
  );
}
