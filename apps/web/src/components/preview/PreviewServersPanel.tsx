import type { ProjectScript, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { discoveredServerTarget } from "~/browser/browserTargetResolver";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { openPreviewSession } from "./openPreviewSession";
import { useRightPanelStore } from "~/rightPanelStore";

export function PreviewServersPanel({
  threadRef,
  scripts,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly scripts: ReadonlyArray<ProjectScript>;
}) {
  const servers = useEnvironmentQuery(
    previewEnvironment.servers({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const open = useAtomCommand(previewEnvironment.open);
  const openServer = async (url: string) => {
    const target = discoveredServerTarget(url);
    const result = await openPreviewSession({
      openPreview: open,
      threadRef,
      url,
      ...(target.kind === "environment-port"
        ? { environmentPort: { port: target.port, protocol: target.protocol ?? "http" } }
        : {}),
    });
    if (result._tag === "Success")
      useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
  };
  const start = useAtomCommand(previewEnvironment.startServer);
  const stop = useAtomCommand(previewEnvironment.stopServer);
  const restart = useAtomCommand(previewEnvironment.restartServer);
  const [pending, setPending] = useState<string | null>(null);
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
    <details className="border-b border-border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Preview servers</summary>
      <div className="flex flex-col gap-2 py-2">
        {servers.error ? (
          <p role="status" className="text-muted-foreground">
            Preview server controls are unavailable in this environment. Update its server to use
            managed previews.
          </p>
        ) : null}
        {scripts.length === 0 ? (
          <p className="text-muted-foreground">
            Add a project script to start a named preview server.
          </p>
        ) : null}
        {scripts.map((script) => {
          const server = servers.data?.find((candidate) => candidate.scriptId === script.id);
          const running = server?.status === "ready" || server?.status === "starting";
          return (
            <div key={script.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{script.name}</span>
                <span role="status" className="text-xs text-muted-foreground">
                  {server?.status ?? "stopped"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null || Boolean(servers.error)}
                  onClick={() => void run(script.id, running ? "stop" : "start")}
                >
                  {running ? "Stop" : "Start"}
                </Button>
                {server ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null || Boolean(servers.error)}
                    onClick={() => void run(script.id, "restart")}
                  >
                    Restart
                  </Button>
                ) : null}
              </div>
              {server?.url ? (
                isPreviewSupportedInRuntime() ? (
                  <button
                    className="truncate text-left text-xs underline"
                    onClick={() => void openServer(server.url!)}
                  >
                    Open {server.url}
                  </button>
                ) : (
                  <span className="select-text text-xs">
                    {server.url} · Open on the connected desktop
                  </span>
                )
              ) : null}
              {server?.message ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {server.message}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}
