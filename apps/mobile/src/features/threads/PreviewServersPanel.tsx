import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ProjectScript, ScopedThreadRef } from "@t3tools/contracts";
import { PreviewVerificationPanel } from "./PreviewVerificationPanel";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function PreviewServersPanel({
  threadRef,
  scripts,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly scripts: ReadonlyArray<ProjectScript>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const servers = useEnvironmentQuery(
    expanded
      ? previewEnvironment.servers({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const start = useAtomCommand(previewEnvironment.startServer);
  const stop = useAtomCommand(previewEnvironment.stopServer);
  const restart = useAtomCommand(previewEnvironment.restartServer);
  const run = async (scriptId: string, action: "start" | "stop" | "restart") => {
    setPending(scriptId);
    try {
      await { start, stop, restart }[action]({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, scriptId },
      });
    } finally {
      setPending(null);
    }
  };
  return (
    <View className="border-b border-border bg-screen px-4 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-10 justify-center"
      >
        <Text className="font-medium text-foreground">Preview servers {expanded ? "−" : "+"}</Text>
      </Pressable>
      {expanded ? (
        <View className="gap-3 pb-3">
          <Text className="text-xs text-foreground-muted">
            Servers run in this environment. Agent browser checks require a connected desktop host.
          </Text>
          {servers.error ? (
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
              Preview controls are unavailable. Update this environment's server.
            </Text>
          ) : null}
          {scripts.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              Add a project script to start a preview server.
            </Text>
          ) : null}
          {scripts.map((script) => {
            const server = servers.data?.find((candidate) => candidate.scriptId === script.id);
            const running = server?.status === "ready" || server?.status === "starting";
            return (
              <View key={script.id} className="gap-1">
                <View className="flex-row items-center gap-3">
                  <Text className="flex-1 text-sm text-foreground">
                    {script.name} · {server?.status ?? "stopped"}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${running ? "Stop" : "Start"} ${script.name}`}
                    disabled={pending !== null || Boolean(servers.error)}
                    onPress={() => void run(script.id, running ? "stop" : "start")}
                    className="min-h-11 justify-center px-2"
                  >
                    <Text className="text-sm text-foreground">{running ? "Stop" : "Start"}</Text>
                  </Pressable>
                  {server ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Restart ${script.name}`}
                      disabled={pending !== null || Boolean(servers.error)}
                      onPress={() => void run(script.id, "restart")}
                      className="min-h-11 justify-center px-2"
                    >
                      <Text className="text-sm text-foreground">Restart</Text>
                    </Pressable>
                  ) : null}
                </View>
                {server?.url ? (
                  <Text selectable className="text-xs text-foreground-muted">
                    {server.url}
                  </Text>
                ) : null}
                {server?.message ? (
                  <Text accessibilityRole="alert" className="text-xs text-foreground-muted">
                    {server.message}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
      <PreviewVerificationPanel threadRef={threadRef} compact={!expanded} />
    </View>
  );
}
