require("dotenv").config();

const express = require("express");
const axios = require("axios");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const AUTH_DIR = "/tmp/auth";

let sock = null;
let qrCode = null;

/*
|--------------------------------------------------------------------------
| DOWNLOAD SESSION
|--------------------------------------------------------------------------
*/

async function downloadSession() {
  try {
    const response = await axios.get(
      `${process.env.PHP_BASE_URL}/session.php`,
      {
        headers: {
          "x-api-key": process.env.API_KEY
        },
        responseType: "arraybuffer"
      }
    );

    if (!response.data || response.data.byteLength === 0) {
      return;
    }

    fs.mkdirSync(AUTH_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(AUTH_DIR, "creds.json"),
      response.data
    );

    console.log("SESSION DOWNLOADED");
  } catch (err) {
    console.log("NO SESSION FOUND");
  }
}

/*
|--------------------------------------------------------------------------
| SAVE SESSION
|--------------------------------------------------------------------------
*/

async function saveSession() {
  try {
    const credsPath = path.join(
      AUTH_DIR,
      "creds.json"
    );

    if (!fs.existsSync(credsPath)) {
      return;
    }

    const data = fs.readFileSync(credsPath);

    await axios.post(
      `${process.env.PHP_BASE_URL}/save-session.php`,
      data,
      {
        headers: {
          "x-api-key": process.env.API_KEY,
          "Content-Type": "application/octet-stream"
        }
      }
    );

    console.log("SESSION SAVED");
  } catch (err) {
    console.log(err.message);
  }
}

/*
|--------------------------------------------------------------------------
| START WHATSAPP
|--------------------------------------------------------------------------
*/

async function startWhatsApp() {
  await downloadSession();

  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({
      level: "silent"
    })
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await saveSession();
  });

  sock.ev.on(
    "connection.update",
    async ({ connection, qr }) => {

      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
        console.log("QR GENERATED");
      }

      if (connection === "open") {
        console.log("CONNECTED");

        qrCode = null;

        await saveSession();
      }

      if (connection === "close") {
        console.log("DISCONNECTED");

        setTimeout(() => {
          startWhatsApp();
        }, 5000);
      }
    }
  );

  sock.ev.on(
    "messages.upsert",
    async ({ messages }) => {

      try {

        const msg = messages[0];

        if (!msg.message) return;

        if (msg.key.fromMe) return;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        const from =
          msg.key.remoteJid;

        console.log(
          "MESSAGE:",
          from,
          text
        );

        await axios.post(
          `${process.env.PHP_BASE_URL}/webhook.php`,
          {
            from,
            text
          },
          {
            headers: {
              "x-api-key":
                process.env.API_KEY
            }
          }
        );

      } catch (err) {
        console.log(err.message);
      }

    }
  );
}

startWhatsApp();

/*
|--------------------------------------------------------------------------
| QR
|--------------------------------------------------------------------------
*/

app.get("/qr", (req, res) => {
  res.json({
    connected: !!sock?.user,
    qr: qrCode
  });
});

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

app.get("/status", (req, res) => {

  res.json({
    connected: !!sock?.user,
    number: sock?.user?.id || null
  });

});

/*
|--------------------------------------------------------------------------
| SEND
|--------------------------------------------------------------------------
*/

app.post("/send", async (req, res) => {

  try {

    const {
      apiKey,
      to,
      text
    } = req.body;

    if (
      apiKey !== process.env.API_KEY
    ) {
      return res
        .status(401)
        .json({
          error: "Unauthorized"
        });
    }

    await sock.sendMessage(
      to,
      {
        text
      }
    );

    res.json({
      success: true
    });

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }

});

app.listen(PORT, () => {
  console.log(
    "WHATSAPP GATEWAY STARTED"
  );
});
