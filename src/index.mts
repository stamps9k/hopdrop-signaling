import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
	ws.close(200, "ok");
  // signaling.ts logic togo here
});

server.listen(3000);