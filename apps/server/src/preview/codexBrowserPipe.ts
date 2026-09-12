import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  const detail =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : undefined;
  return (detail && detail !== message ? `${message} ${detail}` : message).slice(0, 2_000);
};

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(Json);
const decodeJson = Schema.decodeSync(Json);
export const browserRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const Request = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const littleEndian = NodeOS.endianness() === "LE";

export function browserPipeFrame(value: unknown): Buffer {
  const body = Buffer.from(encodeJson(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error("Browser response exceeds 16 MiB.");
  const header = Buffer.allocUnsafe(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function browserPipeDecoder(onMessage: (message: unknown) => void) {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = littleEndian ? pending.readUInt32LE() : pending.readUInt32BE();
      if (length > MAX_FRAME_BYTES) throw new Error("Browser request exceeds 16 MiB.");
      if (pending.length < length + 4) return;
      const body = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      onMessage(decodeJson(body.toString("utf8")));
    }
  };
}

const decodeRequest = Schema.decodeUnknownSync(Request);

export interface BrowserPipePeer {
  readonly signal: AbortSignal;
  readonly notify: (method: string, params: unknown) => void;
}

/** The installed Codex browser service discovers this directory itself. This
 * serves a T3-owned endpoint; it never connects to the desktop app's sockets. */
export async function listenBrowserPipe(options: {
  readonly dispatch: (
    method: string,
    params: Record<string, unknown>,
    peer: BrowserPipePeer,
  ) => Promise<unknown>;
  readonly path: string;
}) {
  const path = options.path;
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    const send = (message: unknown) => {
      if (socket.destroyed) return;
      // A stalled peer must not retain an unbounded stream of CDP events.
      if (socket.writableLength > MAX_FRAME_BYTES) return void socket.destroy();
      socket.write(browserPipeFrame(message));
    };
    const peer: BrowserPipePeer = {
      signal: controller.signal,
      notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
    };
    let inFlight = 0;
    const receive = browserPipeDecoder((message) => {
      const request = decodeRequest(message);
      if (++inFlight > 128) throw new Error("Too many concurrent browser requests.");
      const id = request.id;
      const respond = (result: unknown) => {
        if (id !== undefined) send({ jsonrpc: "2.0", id, result: result ?? null });
      };
      void Promise.resolve()
        .then(() => options.dispatch(request.method, request.params ?? {}, peer))
        .then(respond)
        .catch((error: unknown) => {
          if (id !== undefined)
            send({
              jsonrpc: "2.0",
              id,
              error: {
                code: -1,
                message: errorMessage(error),
              },
            });
        })
        .finally(() => {
          inFlight--;
        });
    });
    socket.on("data", (chunk) => {
      try {
        receive(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      sockets.delete(socket);
      controller.abort();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
