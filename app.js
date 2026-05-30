require("dotenv").config();

const express = require("express");
const axios = require("axios");
const qrcode = require("qrcode");
const pino = require("pino");
const fs = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let sock = null;

let qrBase64 = null;
let isConnected = false;
let connecting = false;
let retryCount = 0;

/* =========================
   QR ROUTES
========================= */

// JSON QR
app.get("/qr", (req, res) => {
  res.json({
    connected: isConnected,
    qr: qrBase64
  });
});

// QR image
app.get("/qr.png", (req, res) => {
  if (!qrBase64) return res.status(404).send("QR not ready");

  const base64 = qrBase64.split(",")[1];
  const img = Buffer.from(base64, "base64");

  res.setHeader("Content-Type", "image/png");
  res.send(img);
});

/* =========================
   SEND MESSAGE ROUTE
========================= */

app.post("/send", async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!sock) {
      return res.status(500).json({ error: "WhatsApp not ready" });
    }

    if (!to || !text) {
      return res.status(400).json({ error: "to and text required" });
    }

    await sock.sendMessage(to, { text });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START BOT
========================= */

async function startBot() {
  if (connecting) return;
  connecting = true;

  try {
    console.log("🚀 Starting WhatsApp...");

    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      browser: ["Bot", "Chrome", "1.0"]
    });

    /* =========================
       CONNECTION UPDATE
    ========================= */
    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        console.log("📲 QR generated");
        qrBase64 = await qrcode.toDataURL(qr);
      }

      if (connection === "open") {
        console.log("✅ Connected");
        isConnected = true;
        qrBase64 = null;
        retryCount = 0;
      }

      if (connection === "close") {
        isConnected = false;
        qrBase64 = null;

        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("❌ Closed:", code);

        const shouldReconnect = code !== DisconnectReason.loggedOut;

        if (!shouldReconnect) {
          console.log("🚫 Logged out, stop reconnect");
          return;
        }

        retryCount++;
        const delay = Math.min(30000, retryCount * 4000);

        console.log(`🔁 Reconnecting in ${delay}ms`);

        setTimeout(() => {
          connecting = false;
          startBot();
        }, delay);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    /* =========================
       WEBHOOK (INCOMING MSG)
    ========================= */
    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages?.[0];
      if (!msg?.message) return;
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      console.log("📩 Incoming:", from, text);

      // webhook
      if (process.env.WEBHOOK_URL) {
        try {
          await axios.post(process.env.WEBHOOK_URL, {
            from,
            text
          });
        } catch (err) {
          console.log("Webhook error:", err.message);
        }
      }
    });

  } catch (err) {
    console.log("💥 Fatal:", err.message);

    setTimeout(() => {
      connecting = false;
      startBot();
    }, 5000);
  } finally {
    connecting = false;
  }
}

/* =========================
   ROOT
========================= */

app.get("/", (req, res) => {
  res.send("WhatsApp Bot Running");
});

/* =========================
   START
========================= */

startBot();

app.listen(PORT, () => {
  console.log("🌐 Server running on port", PORT);
});