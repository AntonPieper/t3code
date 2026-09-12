import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { useAssetUrlState } from "~/assets/assetUrls";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";

export function PreviewVerificationPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
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
  return (
    <section className="border-b border-border px-3 py-2 text-sm" aria-label="Preview verification">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={state.data?.enabled ?? false}
          disabled={pending || !state.data || Boolean(state.error)}
          onChange={(event) => void toggle(event.target.checked)}
        />
        Verify completed changes in this thread
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Runs one additional agent turn, up to five minutes, using the connected desktop. Uses your
        current model and effort.
      </p>
      {state.error ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Verification is unavailable in this environment. Update its server.
        </p>
      ) : null}
      {run ? (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <p role="status" className="min-w-0 flex-1">
              <span className="capitalize">{run.status}</span> · {run.summary}
            </p>
            {run.status === "running" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void cancel({
                    environmentId: threadRef.environmentId,
                    input: { threadId: threadRef.threadId },
                  })
                }
              >
                Stop
              </Button>
            ) : null}
          </div>
          {run.url ? <p className="break-all text-xs text-muted-foreground">{run.url}</p> : null}
          {run.evidencePaths.map((path, index) => (
            <VerificationEvidence
              key={path}
              threadRef={threadRef}
              path={path}
              label={`Evidence ${index + 1}`}
            />
          ))}
        </div>
      ) : null}
    </section>
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
  const asset = useAssetUrlState(threadRef.environmentId, {
    _tag: "media-file",
    threadId: threadRef.threadId,
    path,
  });
  return asset._tag === "Success" ? (
    <a className="text-xs underline" href={asset.url} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <span className="text-xs text-muted-foreground">
      {label} · {asset._tag === "Failure" ? "unavailable" : "loading"}
    </span>
  );
}
