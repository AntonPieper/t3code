import { useState } from "react";
import { Linking, Pressable, Switch, Text, View } from "react-native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAssetUrlState } from "../../state/assets";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import { VideoPreviewModal } from "../../components/VideoPreviewModal";

export function PreviewVerificationPanel({
  threadRef,
  compact = false,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly compact?: boolean;
}) {
  const state = useEnvironmentQuery(
    previewEnvironment.verification({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const setEnabled = useAtomCommand(previewEnvironment.setVerification);
  const cancel = useAtomCommand(previewEnvironment.cancelVerification);
  const [pending, setPending] = useState(false);
  const toggle = async (enabled: boolean) => {
    setPending(true);
    try {
      await setEnabled({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, enabled },
      });
    } finally {
      setPending(false);
    }
  };
  const run = state.data?.run;
  if (compact)
    return run ? (
      <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
        Verification {run.status} · {run.summary}
      </Text>
    ) : null;
  return (
    <View className="gap-2 border-t border-border pt-3">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-sm text-foreground">
          Verify completed changes in this thread
        </Text>
        <Switch
          accessibilityLabel="Verify completed changes in this thread"
          value={state.data?.enabled ?? false}
          disabled={pending || !state.data || Boolean(state.error)}
          onValueChange={(enabled) => void toggle(enabled)}
        />
      </View>
      <Text className="text-xs text-foreground-muted">
        Runs one additional agent turn, up to five minutes, using the connected desktop and your
        current model and effort.
      </Text>
      {state.error ? (
        <Text accessibilityRole="alert" className="text-xs text-foreground-muted">
          Verification is unavailable. Update this environment's server.
        </Text>
      ) : null}
      {run ? (
        <View className="gap-2">
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {run.status} · {run.summary}
          </Text>
          {run.status === "running" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void cancel({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId },
                })
              }
              className="min-h-11 justify-center"
            >
              <Text className="text-sm text-foreground">Stop verification</Text>
            </Pressable>
          ) : null}
          {run.url ? (
            <Text selectable className="text-xs text-foreground-muted">
              {run.url}
            </Text>
          ) : null}
          {run.evidencePaths.map((path, index) => (
            <VerificationEvidence
              key={path}
              threadRef={threadRef}
              path={path}
              label={`Open evidence ${index + 1}`}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function VerificationEvidence({
  threadRef,
  path,
  label,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly label: string;
}) {
  const [opened, setOpened] = useState<"image" | "video" | null>(null);
  const resource = { _tag: "media-file", threadId: threadRef.threadId, path } as const;
  const asset = useAssetUrlState(threadRef.environmentId, resource);
  const url = asset._tag === "Success" ? asset.url : null;
  const name = path.split(/[\\/]/).at(-1) ?? label;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        disabled={!url}
        onPress={() => {
          if (!url) return;
          if (/\.(mp4|webm)$/i.test(path)) setOpened("video");
          else if (/\.(png|jpe?g|webp)$/i.test(path)) setOpened("image");
          else void Linking.openURL(url);
        }}
        className="min-h-11 justify-center"
      >
        <Text className="text-sm text-foreground underline">
          {url ? label : `${label} · unavailable`}
        </Text>
      </Pressable>
      <VideoPreviewModal
        source={
          opened === "video"
            ? {
                type: "media",
                name,
                mimeType: /\.webm$/i.test(path) ? "video/webm" : "video/mp4",
                environmentId: threadRef.environmentId,
                resource,
              }
            : null
        }
        onRequestClose={() => setOpened(null)}
      />
      <FilePreviewModal
        source={
          opened === "image"
            ? { kind: "image", name, environmentId: threadRef.environmentId, resource }
            : null
        }
        onRequestClose={() => setOpened(null)}
      />
    </>
  );
}
