require("dotenv").config();

const express = require("express");
const qrcode = require("qrcode");
const P = require("pino");

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
let qrCode = null;
let connected = false;
let connecting = false;

async function startWhatsApp() {

    if (connecting) return;
    connecting = true;

    try {

        const { state, saveCreds } =
            await useMultiFileAuthState("auth");

        const { version } =
            await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: "silent" }),
            browser: ["KiroFlix", "Chrome", "1.0"]
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {

            const {
                connection,
                qr,
                lastDisconnect
            } = update;

            if (qr) {
                qrCode = await qrcode.toDataURL(qr);
                console.log("QR Generated");
            }

            if (connection === "open") {
                connected = true;
                qrCode = null;
                console.log("Connected");
            }

            if (connection === "close") {

                connected = false;

                const code =
                    lastDisconnect?.error?.output?.statusCode;

                console.log("Disconnected:", code);

                if (
                    code !== DisconnectReason.loggedOut
                ) {

                    setTimeout(() => {
                        connecting = false;
                        startWhatsApp();
                    }, 5000);

                }
            }

        });

    } catch (err) {

        console.log(err);

        setTimeout(() => {
            connecting = false;
            startWhatsApp();
        }, 5000);

    } finally {
        connecting = false;
    }

}

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

app.get("/status", (req, res) => {

    res.json({
        connected
    });

});

/*
|--------------------------------------------------------------------------
| QR
|--------------------------------------------------------------------------
*/

app.get("/qr", (req, res) => {

    res.json({
        connected,
        qr: qrCode
    });

});

/*
|--------------------------------------------------------------------------
| SEND
|--------------------------------------------------------------------------
*/

app.post("/send", async (req, res) => {

    try {

        const { to, text } = req.body;

        if (!connected) {
            return res.status(400).json({
                success: false,
                message: "WhatsApp not connected"
            });
        }

        await sock.sendMessage(to, {
            text
        });

        res.json({
            success: true
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });

    }

});

/*
|--------------------------------------------------------------------------
| HOME
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.send("WhatsApp Gateway Running");
});

startWhatsApp();

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
