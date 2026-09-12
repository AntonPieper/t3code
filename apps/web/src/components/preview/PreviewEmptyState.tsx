import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Globe } from "lucide-react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({
  threadRef,
  environmentId,
  configuredUrls,
  recentEntries,
  onRemoveRecent,
  onOpenUrl,
}: Props) {
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
  });
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);

  if (servers.length === 0 && recents.length === 0) {
    return (
      <div className="flex h-full items-start justify-center overflow-y-auto px-6 py-12">
        <div className="flex w-full max-w-sm flex-col items-start gap-4">
          <Globe className="size-6 text-muted-foreground" aria-hidden />
          <div className="space-y-2">
            <h2 className="text-base font-medium">Open a page</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Enter an address above, or start your app. Available local servers will appear here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 py-6">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {servers.length > 0 ? (
          <section className="space-y-2" aria-label="Local servers">
            <h2 className="px-2 text-xs font-medium text-muted-foreground">Local servers</h2>
            <div className="flex flex-col">
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  threadRef={threadRef}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
          </section>
        ) : null}
        {recents.length > 0 ? (
          <section className="space-y-2" aria-label="Recently used">
            <h2 className="px-2 text-xs font-medium text-muted-foreground">Recently used</h2>
            <div className="flex flex-col">
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  threadRef={threadRef}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
