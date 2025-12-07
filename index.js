/**
 * @file index.js
 * @brief Clean, production-ready backend for Hotel IoT ESP32 + Dashboard.
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const WebSocket = require("ws");

const app = express();

/* ----------------------------
   1. EXPRESS MIDDLEWARE
---------------------------- */
app.use(express.json());

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(cors({ origin: "*", credentials: true }));

app.get("/", (req, res) =>
  res.json({
    status: "Server OK",
    websocket: "/mqtt",
    sse: "/api/events/:hotelId",
    timestamp: new Date().toISOString(),
  })
);

/* ----------------------------
   2. RAILWAY PORT FIX (CRITICAL)
---------------------------- */
const PORT = process.env.PORT;

if (!PORT) {
  console.error("❌ Railway PORT not found in env!");
  process.exit(1);
}

/* ----------------------------
   3. CREATE HTTP SERVER
---------------------------- */
const server = http.createServer(app);

/* ----------------------------
   4. CREATE WEBSOCKET /mqtt SERVER
---------------------------- */
const mqttWsServer = new WebSocket.Server({ noServer: true });

mqttWsServer.on("connection", (ws, req) => {
  console.log("🔗 ESP32 WebSocket connected");

  ws.on("message", async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      console.log("📨 ESP32 MQTT JSON:", msg);

      if (msg.cmd === "publish") {
        ws.send(JSON.stringify({ status: "ok", topic: msg.topic }));
        // Here your MQTT → DB logic can be plugged back cleanly
      }
    } catch (err) {
      console.error("❌ WS message error:", err.message);
    }
  });

  ws.on("close", () => console.log("📡 ESP32 disconnected"));
  ws.on("error", (err) => console.log("❌ ESP32 WS error:", err.message));
});

/* ----------------------------
   5. FRONTEND WEBSOCKET /ws (optional)
---------------------------- */
const frontendWsServer = new WebSocket.Server({ noServer: true });
const frontendClients = new Set();

frontendWsServer.on("connection", (ws, req) => {
  console.log("🌐 Frontend dashboard WebSocket connected");
  frontendClients.add(ws);

  ws.send(JSON.stringify({ event: "connected", time: new Date() }));

  ws.on("close", () => frontendClients.delete(ws));
});

/* ----------------------------
   6. MANUAL UPGRADE HANDLER (CRITICAL FIX)
---------------------------- */
server.on("upgrade", (req, socket, head) => {
  const path = req.url.split("?")[0];

  console.log("⬆ Upgrade request:", path);

  if (path === "/mqtt") {
    mqttWsServer.handleUpgrade(req, socket, head, (ws) => {
      mqttWsServer.emit("connection", ws, req);
    });

  } else if (path === "/ws") {
    frontendWsServer.handleUpgrade(req, socket, head, (ws) => {
      frontendWsServer.emit("connection", ws, req);
    });

  } else {
    console.log("❌ Invalid WS path, closing socket.", path);
    socket.destroy();
  }
});

/* ----------------------------
   7. SSE STREAM (kept clean)
---------------------------- */
app.get("/api/events/:hotelId", (req, res) => {
  const { hotelId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`data: ${JSON.stringify({ event: "connected", hotelId })}\n\n`);

  const timer = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 25000);

  req.on("close", () => clearInterval(timer));
});

/* ----------------------------
   8. MONGODB (NON-BLOCKING)
---------------------------- */
const MONGO_URL = process.env.MONGO_URL;

mongoose
  .connect(MONGO_URL)
  .then(() => console.log("📦 MongoDB connected"))
  .catch((err) => {
    console.error("⚠ MongoDB connection failed:", err.message);
    console.log("➡ Running in NO-DB mode, WS still works");
  });

/* ----------------------------
   9. START HTTP + WS SERVER
---------------------------- */
server.listen(PORT, () =>
  console.log(`🚀 Server ready on ${PORT} | WS: /mqtt | /ws`)
);
