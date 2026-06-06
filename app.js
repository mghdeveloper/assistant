require("dotenv").config();

const express = require("express");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const archiver = require("archiver").default || require("archiver");
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
const backupLocks = {};
const watchers = {};
const WEBHOOK_URL = process.env.WEBHOOK_URL;

function authPath(id) {
    return path.join("auth", id);
}

function zipPath(id) {
    return path.join("backup", `${id}.zip`);
}

fs.mkdirSync("auth", { recursive: true });
fs.mkdirSync("backup", { recursive: true });

/* ---------------- SAFE BACKUP ENGINE ---------------- */

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
    if (backupLocks[sessionId]) return;

    backupLocks[sessionId] = true;

    try {
        await zipSession(sessionId);

        const form = new FormData();
        form.append("session", sessionId);
        form.append("file", fs.createReadStream(zipPath(sessionId)));

        await axios.post(`${BASE_URL}/upload.php`, form, {
            headers: form.getHeaders()
        });

        console.log(`[${sessionId}] backup synced`);
    } catch (err) {
        console.error(`[${sessionId}] backup error`, err.message);
    } finally {
        setTimeout(() => {
            backupLocks[sessionId] = false;
        }, 8000);
    }
}

/* ---------------- FILE WATCHER (REAL CHANGE DETECTION) ---------------- */

function watchSessionFiles(sessionId) {
    const dir = authPath(sessionId);

    if (watchers[sessionId]) return;

    watchers[sessionId] = fs.watch(dir, async (event, filename) => {
        if (!filename) return;

        console.log(`[${sessionId}] auth changed → syncing backup`);
        await uploadBackup(sessionId);
    });
}

/* ---------------- RESTORE ---------------- */

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

        console.log(`[${sessionId}] restored`);
        return true;
    } catch {
        return false;
    }
}

/* ---------------- SESSION CORE ---------------- */

async function createSession(sessionId) {
    if (sessions[sessionId]) return sessions[sessionId];

    fs.mkdirSync(authPath(sessionId), { recursive: true });

    const empty = fs.readdirSync(authPath(sessionId)).length === 0;
    if (empty) await downloadBackup(sessionId);

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

        // prevent duplicate sockets
        if (session.sock) {
            try { session.sock.end(); } catch {}
        }

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: "silent" }),
            browser: ["KiroFlix", "Chrome", "1.0"]
        });

        session.sock = sock;
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            const { downloadMediaMessage } = require("@whiskeysockets/baileys");

    for (const msg of messages) {
        if (!msg.message) continue;

// ❌ BLOCK GROUPS + STATUS
const isGroup = msg.key.remoteJid?.endsWith("@g.us");
const isStatus = msg.key.remoteJid === "status@broadcast";
if (isGroup || isStatus) continue;

        try {

            if (!msg.message) continue;
            console.log("\n\n========== WHATSAPP RAW MESSAGE ==========");
console.log("KEY:", msg.key);
console.log("MESSAGE TYPE KEYS:", Object.keys(msg.message || {}));
console.log("FULL MESSAGE:");
console.dir(msg.message, { depth: null });
console.log("=========================================\n\n");

            session.lastActivity = Date.now();

            function extractText(msg) {
    const m = msg.message;

    return (
        m?.conversation ||
        m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption ||
        m?.videoMessage?.caption ||
        m?.documentMessage?.caption ||
        m?.ephemeralMessage?.message?.imageMessage?.caption ||
        m?.ephemeralMessage?.message?.videoMessage?.caption ||
        m?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        null
    );
}
            const text = extractText(msg);
            let mediaType = "text";
let mediaBuffer = null;
            if (msg.message.imageMessage) {
    mediaType = "image";
}

if (msg.message.audioMessage) {
    mediaType = "audio";
}
            if (mediaType !== "text") {
    try {
        mediaBuffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            {
                reuploadRequest: session.sock.updateMediaMessage
            }
        );
    } catch (e) {
        console.log("media download failed", e.message);
    }
}

            let reply = null;

            const ctx =
                msg.message?.extendedTextMessage?.contextInfo ||
                msg.message?.imageMessage?.contextInfo ||
                msg.message?.videoMessage?.contextInfo;

            if (ctx?.stanzaId) {
                reply = {
                    message_id: ctx.stanzaId,
                    participant: ctx.participant,
                    quoted_text: ctx.quotedMessage?.conversation ||
                                 ctx.quotedMessage?.extendedTextMessage?.text ||
                                 null
                };
            }

            await axios.post(WEBHOOK_URL, {
    event: "message",
    session: sessionId,

    message: {
        id: msg.key.id,
        chat: msg.key.remoteJid,
        sender: msg.key.participant || msg.key.remoteJid,
        from_me: msg.key.fromMe,
        timestamp: msg.messageTimestamp,

        type: mediaType,

        text: mediaType === "text" ? text : null,

        media: mediaType !== "text" ? {
    type: mediaType,
    mimetype:
        msg.message.imageMessage?.mimetype ||
        msg.message.audioMessage?.mimetype ||
        null,

    buffer: mediaBuffer ? mediaBuffer.toString("base64") : null
} : null,

        reply
    }
});

        } catch (err) {
            console.error(
                `[${sessionId}] webhook error`,
                err.message
            );
        }
    }
});

        watchSessionFiles(sessionId);

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (u) => {
            const { connection, qr, lastDisconnect } = u;

            if (qr) {
                session.qr = await qrcode.toDataURL(qr);
            }

            if (connection === "open") {
                session.connected = true;
                session.qr = null;

                console.log(`[${sessionId}] connected`);

                await uploadBackup(sessionId);
            }

            if (connection === "close") {
    session.connected = false;

    const code = lastDisconnect?.error?.output?.statusCode;

    console.log(`[${sessionId}] disconnected (${code})`);

    // logged out from phone
    if (code === DisconnectReason.loggedOut) {
        await deleteSession(sessionId);
        return;
    }

    // retry connection
    setTimeout(() => {
        if (sessions[sessionId]) {
            startSession(sessionId);
        }
    }, 4000);
}
        });

    } catch (err) {
        console.error(`[${sessionId}] start error`, err.message);
    } finally {
        session.connecting = false;
    }
    
}

/* ---------------- RESTORE ALL ---------------- */

async function restoreAll() {
    try {
        const res = await axios.get(`${BASE_URL}/list.php`);
        for (const id of res.data.sessions || []) {
            console.log(`[BOOT] restoring ${id}`);
            await createSession(id);
        }
    } catch (err) {
        console.log("restore failed", err.message);
    }
}

async function deleteSession(sessionId) {
    try {
        // close socket
        sessions[sessionId]?.sock?.end?.();
    } catch {}

    // close watcher
    try {
        watchers[sessionId]?.close?.();
    } catch {}

    delete watchers[sessionId];
    delete backupLocks[sessionId];
    delete sessions[sessionId];

    // remove auth files
    fs.rmSync(authPath(sessionId), {
        recursive: true,
        force: true
    });

    // remove zip backup
    fs.rmSync(zipPath(sessionId), {
        force: true
    });

    // notify your server
    try {
        await axios.post(`${BASE_URL}/delete.php`, {
            session: sessionId
        });
    } catch (err) {
        console.error(`[${sessionId}] remote delete failed`, err.message);
    }

    console.log(`[${sessionId}] deleted`);
}
/* ---------------- API (FRONTEND FRIENDLY) ---------------- */

app.get("/", (req, res) => {
    res.json({ ok: true });
});

app.get("/status", (req, res) => {
    const { session } = req.query;

    const s = sessions[session];

    res.json({
        session,
        connected: !!(s?.sock?.user?.id),
        hasSession: !!s,
        connecting: s?.connecting || false
    });
});

app.get("/qr", async (req, res) => {
    const { session } = req.query;
    if (!session) return res.status(400).json({ error: "session required" });

    const s = await createSession(session);
    await new Promise(r => setTimeout(r, 1500));

    res.json({
        session,
        qr: s?.qr || null,
        connected: !!s?.sock?.user?.id
    });
});

app.post("/send", async (req, res) => {
    const { session, to, text } = req.body;

    const s = sessions[session];
    if (!s?.sock?.user) return res.status(400).json({ error: "not connected" });

    await s.sock.sendMessage(to, { text });

    res.json({ success: true });
});

app.post("/logout", async (req, res) => {
    const { session } = req.body;

    try {
        sessions[session]?.sock?.end();
    } catch {}

    delete sessions[session];

    fs.rmSync(authPath(session), { recursive: true, force: true });

    res.json({ success: true });
});

/* ---------------- CLEANER ---------------- */

setInterval(() => {
    const now = Date.now();

    for (const [id, s] of Object.entries(sessions)) {
        if (now - s.lastActivity > 3600000) {
            delete sessions[id];
        }
    }
}, 300000);

/* ---------------- START ---------------- */

app.listen(PORT, async () => {
    console.log("Server running");
    await restoreAll();
});
