import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  handle_connection,
  handle_client_message,
  handle_disconnect,
  MAX_RAW_MESSAGE_LENGTH,
} from "./signaling.mjs";
import { start_room_cleanup, stop_room_cleanup } from "./rooms.mjs";
import {
  try_accept_connection,
  release_connection,
  extract_client_ip,
  start_rate_limit_cleanup,
  stop_rate_limit_cleanup,
} from "./rate_limit.mjs";

const PORT = Number(process.env.PORT ?? 7420);

// Comma-separated list of origins hopdrop-client is actually served from,
// e.g. "https://hopdrop.example.com". Fails closed (rejects every
// browser-origin connection) if unset, rather than silently allowing
// everything through - a misconfigured deploy should be loud, not quietly
// skip the protection this exists to add.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

if (ALLOWED_ORIGINS.length === 0) {
  console.warn(
    "ALLOWED_ORIGINS is not set - all browser-origin WebSocket connections " +
      "will be rejected. Set it to a comma-separated list of allowed " +
      "origins, e.g. https://hopdrop.example.com",
  );
}

// WebSocket connections aren't covered by the browser's same-origin
// policy or CORS the way fetch/XHR are - any page, on any site, can open
// a WS connection to this server from a visitor's browser, and the
// browser will do it without complaint. Checking Origin here is what
// closes that gap.
//
// A *mismatched* Origin can only come from a browser page we didn't
// intend to serve this server to (the exact cross-site hijacking this
// check exists to stop) - browsers always attach a real Origin to a WS
// handshake and never let page JS override it. A *missing* Origin means
// the client isn't a browser at all (e.g. wscat or a raw script used for
// manual testing, per this project's own established testing practice),
// which this check was never meant to block, so those are let through
// unconditionally rather than failing closed on them too.
function is_allowed_origin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  return ALLOWED_ORIGINS.includes(origin);
}

// Plain http server so we can serve /health outside the WS upgrade path,
// and so the WebSocketServer can attach to it without needing Express.
const http_server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const websocket_server = new WebSocketServer({
  server: http_server,
  // Rejects an oversized frame at the transport level before it's ever
  // fully buffered into a JS string - the primary defense, with
  // signaling.mts's own raw-message-length check as defense-in-depth
  // behind it. Shares the same constant so the two can't drift apart.
  maxPayload: MAX_RAW_MESSAGE_LENGTH,
  // Runs before the WebSocket handshake completes, so a rejected
  // connection never reaches handle_connection/room logic at all —
  // this is the earliest point in our own code we can reject abusive
  // clients (nginx in front handles rejecting non-WS traffic).
  verifyClient: ({ req }, callback) => {
    if (!is_allowed_origin(req.headers.origin)) {
      callback(false, 403, "Forbidden");
      return;
    }

    const ip = extract_client_ip(
      req.headers["x-forwarded-for"],
      req.socket.remoteAddress,
    );
    const accepted = try_accept_connection(ip);
    if (!accepted) {
      callback(false, 429, "Too Many Requests");
      return;
    }
    callback(true);
  },
});

websocket_server.on("connection", (socket: WebSocket, req) => {
  // Recomputed from the same request rather than threaded through from
  // verifyClient, since ws doesn't provide a way to pass data between the
  // two callbacks directly. The extraction is deterministic given the
  // same headers, so this always matches what try_accept_connection saw.
  const ip = extract_client_ip(
    req.headers["x-forwarded-for"],
    req.socket.remoteAddress,
  );

  // ws's WebSocket already has a `send(data: string): void` method, so it
  // satisfies signaling.mts's DeviceConnection interface structurally —
  // no adapter needed.
  const device_id = handle_connection(socket);

  socket.on("message", (raw_data) => {
    handle_client_message(device_id, raw_data.toString());
  });

  socket.on("close", () => {
    handle_disconnect(device_id);
    release_connection(ip);
  });

  socket.on("error", () => {
    // A socket error will be followed by a 'close' event, which already
    // runs handle_disconnect and release_connection — nothing additional
    // to clean up here. Swallowing rather than crashing the process on a
    // single bad socket.
  });
});

start_room_cleanup();
start_rate_limit_cleanup();

http_server.listen(PORT, () => {
  console.log(`hopdrop-signaling listening on port ${PORT}`);
});

function shut_down(): void {
  stop_room_cleanup();
  stop_rate_limit_cleanup();
  websocket_server.close();
  http_server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shut_down);
process.on("SIGTERM", shut_down);
