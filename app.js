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

                if (code === DisconnectReason.loggedOut) return;

                setTimeout(() => startSession(sessionId), 4000);
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
