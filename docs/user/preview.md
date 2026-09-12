# Preview

Open Browser in a thread's right panel to inspect your app with the agent. Keep a
desktop connected to that environment: web and mobile clients can follow server
and verification status, but cannot supply the browser the agent controls.

## Run a preview server

Add a project action in **Settings → Projects** with its start command and an
HTTP(S) localhost preview URL. In the thread's Browser panel, expand **Preview
servers** and start that action. T3 Code runs it in an owned terminal and waits
for its port to respond. Open the ready server to view it in Preview.

Use **Restart** after changing startup configuration, or **Stop** to close that
server's terminal. If the port is occupied or startup fails, inspect the terminal
and correct the action or port before trying again. Starting an already running
preview reuses it.

For a remote environment, open the server from the Preview controls so T3 Code
routes its environment-local port through the authenticated connection. This
also carries app requests and live development updates. The connected desktop
and server must support Preview routing.

## Verify completed changes

Enable **Verify completed changes in this thread** in the Browser panel. After
the agent completes a change, T3 Code requests one additional verification turn
using that thread's provider, model, and effort. Each pass has a five-minute
limit and uses the connected desktop's Preview. This is off by default and uses
additional provider capacity.

The result shows whether the check passed, failed, or was cancelled, with saved
evidence when available. A pass requires an explicit agent report and evidence;
an interrupted or unreported check is not counted as a pass. Review the result
and any unresolved issues before relying on the change.

Use **Stop verification** to cancel the current check. Disable the preference to
cancel it and prevent future checks. Sending new work also supersedes the check.
Verification results and evidence are available on web, desktop, and mobile.
