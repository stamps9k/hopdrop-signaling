import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  handle_connection,
  handle_client_message,
  handle_disconnect,
} from "./signaling.mjs";
import { start_room_cleanup, stop_room_cleanup } from "./rooms.mjs";

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

const websocket_server = new WebSocketServer({ server: http_server });

websocket_server.on("connection", (socket: WebSocket) => {
  // ws's WebSocket already has a `send(data: string): void` method, so it
  // satisfies signaling.mts's DeviceConnection interface structurally —
  // no adapter needed.
  const device_id = handle_connection(socket);

  socket.on("message", (raw_data) => {
    handle_client_message(device_id, raw_data.toString());
  });

  socket.on("close", () => {
    handle_disconnect(device_id);
  });

  socket.on("error", () => {
    // A socket error will be followed by a 'close' event, which already
    // runs handle_disconnect — nothing additional to clean up here.
    // Swallowing rather than crashing the process on a single bad socket.
  });
});

start_room_cleanup();

http_server.listen(PORT, () => {
  console.log(`hopdrop-signaling listening on port ${PORT}`);
});

function shut_down(): void {
  stop_room_cleanup();
  websocket_server.close();
  http_server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shut_down);
process.on("SIGTERM", shut_down);
