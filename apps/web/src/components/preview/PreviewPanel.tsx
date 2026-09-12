"use client";

import type { ProjectScript, PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewVerificationPanel } from "./PreviewVerificationPanel";
import { PreviewServersPanel } from "./PreviewServersPanel";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  scripts: ReadonlyArray<ProjectScript>;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  scripts,
  visible,
  onSendAnnotation,
}: Props) {
  if (!isPreviewSupportedInRuntime()) {
    return (
      <PreviewPanelShell mode={mode}>
        <PreviewServersPanel threadRef={threadRef} scripts={scripts} />
        <PreviewVerificationPanel threadRef={threadRef} />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            Manage preview servers here. Live browser automation requires a connected T3 Code
            desktop host.
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewServersPanel threadRef={threadRef} scripts={scripts} />
      <PreviewVerificationPanel threadRef={threadRef} />
      <PreviewView
        threadRef={threadRef}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
    </PreviewPanelShell>
  );
}
