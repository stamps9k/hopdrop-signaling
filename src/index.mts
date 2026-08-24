import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  handle_connection,
  handle_client_message,
  handle_disconnect,
} from "./signaling.mjs";
import { start_room_cleanup, stop_room_cleanup } from "./rooms.mjs";
import {
  try_accept_connection,
  release_connection,
  extract_client_ip,
  start_rate_limit_cleanup,
  stop_rate_limit_cleanup,
} from "./rate_limit.mjs";

const PORT = Number(process.env.PORT ?? 3000);

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
  // Runs before the WebSocket handshake completes, so a rejected
  // connection never reaches handle_connection/room logic at all —
  // this is the earliest point in our own code we can reject abusive
  // clients (nginx in front handles rejecting non-WS traffic).
  verifyClient: ({ req }, callback) => {
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
