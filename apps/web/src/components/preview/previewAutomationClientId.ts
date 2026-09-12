export function createPreviewAutomationClientId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `preview-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

let clientId: string | undefined;
/** One renderer identity shared by host claims and routing, retained across reload/reconnect. */
export function getPreviewAutomationClientId(): string {
  if (clientId) return clientId;
  try {
    clientId =
      window.sessionStorage.getItem("t3-preview-host") ?? createPreviewAutomationClientId();
    window.sessionStorage.setItem("t3-preview-host", clientId);
  } catch {
    // Restricted storage still permits this renderer to host for its lifetime.
    clientId ??= createPreviewAutomationClientId();
  }
  return clientId;
}
