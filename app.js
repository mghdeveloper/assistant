require("dotenv").config();

const express = require("express");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const archiverImport = require("archiver");
const archiver = archiverImport.default || archiverImport;
const unzipper = require("unzipper");
const FormData = require("form-data");
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

const BASE_URL = "https://websland.kiroflix.site/assistant";

const sessions = {};

function authPath(id) {
    return path.join("auth", id);
}

function zipPath(id) {
    return path.join("backup", `${id}.zip`);
}

fs.mkdirSync("auth", { recursive: true });
fs.mkdirSync("backup", { recursive: true });

/* -------------------- ZIP + UPLOAD -------------------- */

async function zipSession(sessionId) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath(sessionId));
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", resolve);
        archive.on("error", reject);

        archive.pipe(output);
        archive.directory(authPath(sessionId), false);
        archive.finalize();
    });
}

async function uploadBackup(sessionId) {
    try {
        await zipSession(sessionId);

        const form = new FormData();
        form.append("session", sessionId);
        form.append("file", fs.createReadStream(zipPath(sessionId)));

        await axios.post(`${BASE_URL}/upload.php`, form, {
            headers: form.getHeaders()
        });

        console.log(`[${sessionId}] backup uploaded`);
    } catch (err) {
        console.error(`[${sessionId}] backup error`, err.message);
    }
}

/* -------------------- RESTORE -------------------- */

async function downloadBackup(sessionId) {
    try {
        const res = await axios.get(`${BASE_URL}/download.php`, {
            params: { session: sessionId },
            responseType: "stream"
        });

        const zipFile = zipPath(sessionId);
        const writer = fs.createWriteStream(zipFile);

        await new Promise((resolve, reject) => {
            res.data.pipe(writer);
            writer.on("finish", resolve);
            writer.on("error", reject);
        });

        await fs.createReadStream(zipFile)
            .pipe(unzipper.Extract({ path: authPath(sessionId) }))
            .promise();

        console.log(`[${sessionId}] restored from backup`);
        return true;
    } catch (err) {
        console.log(`[${sessionId}] no backup found`);
        return false;
    }
}

/* -------------------- SESSION CORE -------------------- */

async function createSession(sessionId) {
    if (sessions[sessionId]) return sessions[sessionId];

    console.log(`[${sessionId}] creating session`);

    fs.mkdirSync(authPath(sessionId), { recursive: true });

    // restore from server if empty
    const files = fs.readdirSync(authPath(sessionId));
    if (files.length === 0) {
        await downloadBackup(sessionId);
    }

    sessions[sessionId] = {
        sessionId,
        sock: null,
        qr: null,
        connected: false,
        connecting: false,
        lastActivity: Date.now()
    };

    startSession(sessionId);
    return sessions[sessionId];
}

async function startSession(sessionId) {
    const session = sessions[sessionId];
    if (!session || session.connecting) return;

    session.connecting = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath(sessionId));
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: "silent" }),
            browser: ["KiroFlix", "Chrome", "1.0"]
        });

        session.sock = sock;

        sock.ev.on("creds.update", async () => {
            await saveCreds();
            await uploadBackup(sessionId);
        });

        sock.ev.on("connection.update", async (u) => {
            const { connection, qr, lastDisconnect } = u;

            if (qr) {
                session.qr = await qrcode.toDataURL(qr);
            }

            if (connection === "open") {
                session.connected = true;
                session.qr = null;

                await uploadBackup(sessionId);
                console.log(`[${sessionId}] connected`);
            }

            if (connection === "close") {
                session.connected = false;

                const code = lastDisconnect?.error?.output?.statusCode;

                if (code === DisconnectReason.loggedOut) return;

                setTimeout(() => startSession(sessionId), 5000);
            }
        });

    } catch (err) {
        console.error(`[${sessionId}] start error`, err.message);
    } finally {
        session.connecting = false;
    }
}

/* -------------------- AUTO RESTORE ALL ON START -------------------- */

async function restoreAllSessions() {
    try {
        const res = await axios.get(`${BASE_URL}/list.php`);
        const list = res.data.sessions || [];

        for (const id of list) {
            console.log(`[BOOT] restoring ${id}`);
            await createSession(id);
        }
    } catch (err) {
        console.log("restore list failed:", err.message);
    }
}

/* -------------------- API -------------------- */

app.get("/", (req, res) => {
    res.json({ ok: true, service: "WhatsApp Gateway" });
});

app.get("/qr", async (req, res) => {
    const { session } = req.query;
    if (!session) return res.status(400).json({ error: "session required" });

    const s = await createSession(session);
    await new Promise(r => setTimeout(r, 2000));

    res.json({
        session,
        connected: s?.connected,
        qr: s?.qr || null
    });
});

app.post("/send", async (req, res) => {
    const { session, to, text } = req.body;

    if (!session || !to || !text)
        return res.status(400).json({ error: "missing fields" });

    const s = await createSession(session);

    if (!s.connected)
        return res.status(400).json({ error: "not connected" });

    await s.sock.sendMessage(to, { text });
    s.lastActivity = Date.now();

    res.json({ success: true });
});

app.post("/logout", async (req, res) => {
    const { session } = req.body;

    if (sessions[session]?.sock) {
        try { await sessions[session].sock.logout(); } catch {}
    }

    delete sessions[session];
    fs.rmSync(authPath(session), { recursive: true, force: true });

    res.json({ success: true });
});

/* -------------------- CLEANER -------------------- */

setInterval(() => {
    const now = Date.now();

    for (const [id, s] of Object.entries(sessions)) {
        if (now - s.lastActivity > 3600000) {
            delete sessions[id];
        }
    }
}, 300000);

/* -------------------- START -------------------- */

app.listen(PORT, async () => {
    console.log(`Server running on ${PORT}`);
    await restoreAllSessions();
});
