import { Globe, RotateCw } from "lucide-react";

import { Button } from "~/components/ui/button";

import { describePreviewError } from "./errorCodeMessages";

interface Props {
  url: string;
  /** Chromium net error code, e.g. -105. */
  code: number;
  /** Stringified Chromium error, e.g. "ERR_NAME_NOT_RESOLVED". */
  description: string;
  onReload: () => void;
}

export function PreviewUnreachable({ url, code, description, onReload }: Props) {
  const friendly = describePreviewError(description);
  const errorLabel = description || `ERR_${Math.abs(code) || "FAILED"}`;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background px-6 py-12">
      <div className="mx-auto flex w-full max-w-sm flex-col items-start gap-4">
        <Globe className="size-6 text-muted-foreground" aria-hidden />
        <div className="w-full space-y-2" role="status">
          <h2 className="text-base font-medium text-foreground">Can’t reach this page</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {friendly === description ? "The page could not be loaded." : `${friendly}.`}
          </p>
        </div>
        <p className="w-full break-all text-xs text-muted-foreground">{url}</p>
        <Button type="button" size="sm" onClick={onReload}>
          <RotateCw />
          Try again
        </Button>
        <details className="w-full text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Technical details
          </summary>
          <p className="mt-2 break-words font-mono leading-relaxed">
            {errorLabel} ({code})
          </p>
        </details>
      </div>
    </div>
  );
}
