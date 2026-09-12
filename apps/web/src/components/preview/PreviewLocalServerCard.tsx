import type { ScopedThreadRef } from "@t3tools/contracts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ threadRef, server, onOpen }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {server.host}:{server.port}
        </span>
        {server.processName ? (
          <span className="max-w-[40%] truncate text-xs text-muted-foreground">
            {server.processName}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{server.requestedUrl}</p>
        {server.processName ? <p className="text-muted-foreground">{server.processName}</p> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
