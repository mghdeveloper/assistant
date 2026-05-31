```js
require("dotenv").config();

const express = require("express");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const P = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

process.on("unhandledRejection", err => {
    console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", err => {
    console.error("Uncaught Exception:", err);
});

const sessions = {};

function authPath(sessionId) {
    return path.join("auth", sessionId);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sessionExists(sessionId) {
    return Boolean(sessions[sessionId]);
}

async function createSession(sessionId) {
    try {
        if (sessionExists(sessionId)) {
            return sessions[sessionId];
        }

        console.log(`[${sessionId}] Creating session`);

        fs.mkdirSync(authPath(sessionId), {
            recursive: true
        });

        sessions[sessionId] = {
            sessionId,
            sock: null,
            qr: null,
            connected: false,
            connecting: false,
            reconnecting: false,
            lastActivity: Date.now()
        };

        startSession(sessionId);

        return sessions[sessionId];
    } catch (err) {
        console.error(
            `[${sessionId}] createSession error:`,
            err.message
        );

        return null;
    }
}

async function startSession(sessionId) {
    const session = sessions[sessionId];

    if (!session || session.connecting) {
        return;
    }

    session.connecting = true;

    try {
        console.log(`[${sessionId}] Starting session`);

        const { state, saveCreds } =
            await useMultiFileAuthState(
                authPath(sessionId)
            );

        const { version } =
            await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({
                level: "silent"
            }),
            browser: [
                "KiroFlix",
                "Chrome",
                "1.0"
            ]
        });

        session.sock = sock;

        sock.ev.on("creds.update", async () => {
            try {
                await saveCreds();
            } catch (err) {
                console.error(
                    `[${sessionId}] saveCreds error:`,
                    err.message
                );
            }
        });

        sock.ev.on(
            "connection.update",
            async update => {
                try {
                    const {
                        connection,
                        qr,
                        lastDisconnect
                    } = update;

                    if (qr) {
                        session.qr =
                            await qrcode.toDataURL(qr);

                        console.log(
                            `[${sessionId}] QR generated`
                        );
                    }

                    if (connection === "open") {
                        session.connected = true;
                        session.qr = null;

                        console.log(
                            `[${sessionId}] Connected`
                        );
                    }

                    if (connection === "close") {
                        session.connected = false;

                        const code =
                            lastDisconnect?.error
                                ?.output?.statusCode;

                        console.log(
                            `[${sessionId}] Disconnected`,
                            code
                        );

                        if (
                            code ===
                            DisconnectReason.loggedOut
                        ) {
                            console.log(
                                `[${sessionId}] Logged out`
                            );

                            return;
                        }

                        if (
                            session.reconnecting
                        ) {
                            return;
                        }

                        session.reconnecting = true;

                        setTimeout(() => {
                            session.reconnecting = false;

                            startSession(
                                sessionId
                            );
                        }, 5_000);
                    }
                } catch (err) {
                    console.error(
                        `[${sessionId}] connection.update error:`,
                        err.message
                    );
                }
            }
        );
    } catch (err) {
        console.error(
            `[${sessionId}] startSession error:`,
            err.message
        );
    } finally {
        session.connecting = false;
    }
}

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "WhatsApp Gateway"
    });
});

app.get("/qr", async (req, res) => {
    try {
        const { session: sessionId } =
            req.query;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: "session required"
            });
        }

        let session =
            sessions[sessionId];

        if (!session) {
            session =
                await createSession(
                    sessionId
                );

            await wait(3_000);
        }

        res.json({
            success: true,
            session: sessionId,
            connected:
                session?.connected ||
                false,
            qr: session?.qr || null
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.get("/status", async (req, res) => {
    try {
        const { session: sessionId } =
            req.query;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: "session required"
            });
        }

        let session =
            sessions[sessionId];

        if (
            !session &&
            fs.existsSync(
                authPath(sessionId)
            )
        ) {
            session =
                await createSession(
                    sessionId
                );

            await wait(2_000);
        }

        res.json({
            success: true,
            session: sessionId,
            connected:
                session?.connected ||
                false
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.post("/send", async (req, res) => {
    try {
        const {
            session: sessionId,
            to,
            text
        } = req.body;

        if (
            !sessionId ||
            !to ||
            !text
        ) {
            return res.status(400).json({
                success: false,
                error:
                    "session, to and text required"
            });
        }

        let session =
            sessions[sessionId];

        if (
            !session &&
            fs.existsSync(
                authPath(sessionId)
            )
        ) {
            session =
                await createSession(
                    sessionId
                );

            await wait(5_000);
        }

        if (!session) {
            return res.status(404).json({
                success: false,
                error:
                    "session not found"
            });
        }

        if (!session.connected) {
            return res.status(400).json({
                success: false,
                error:
                    "whatsapp not connected"
            });
        }

        await session.sock.sendMessage(
            to,
            { text }
        );

        session.lastActivity =
            Date.now();

        res.json({
            success: true
        });
    } catch (err) {
        console.error(
            "Send Error:",
            err.message
        );

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.post("/logout", async (req, res) => {
    try {
        const {
            session: sessionId
        } = req.body;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error:
                    "session required"
            });
        }

        const session =
            sessions[sessionId];

        try {
            await session?.sock?.logout();
        } catch (err) {
            console.error(
                `[${sessionId}] logout error:`,
                err.message
            );
        }

        delete sessions[sessionId];

        fs.rmSync(
            authPath(sessionId),
            {
                recursive: true,
                force: true
            }
        );

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

setInterval(() => {
    const now = Date.now();

    for (const [id, session] of Object.entries(
        sessions
    )) {
        const inactive =
            now -
                session.lastActivity >
            60 * 60 * 1000;

        if (inactive) {
            console.log(
                `[${id}] Removing inactive session`
            );

            delete sessions[id];
        }
    }
}, 300_000);

app.listen(PORT, () => {
    console.log(
        `Server running on port ${PORT}`
    );
});
```
