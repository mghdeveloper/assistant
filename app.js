require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const archiver = require("archiver").default || require("archiver");
const unzipper = require("unzipper");
const FormData = require("form-data");
const crypto = require("crypto");

const qrcode = require("qrcode");

const P = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");

const app = express();

app.use(express.json({
    limit: "50mb"
}));

app.use(express.urlencoded({
    extended: true,
    limit: "50mb"
}));

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 3000;

const BASE_URL =
    process.env.BASE_URL ||
    "https://websland.kiroflix.site/assistant";

const WEBHOOK_URL =
    process.env.WEBHOOK_URL ||
    "https://websland.kiroflix.site/assistant/webhook.php";

const MAX_RECONNECTS = 15;
const MAX_ERRORS = 10;
const WEBHOOK_TIMEOUT = 30000;
const WEBHOOK_RETRY_INTERVAL = 30000;
const SESSION_IDLE_TIMEOUT = 3600000;

/* =========================================================
   DIRECTORIES
========================================================= */

const DIRS = {
    auth: path.join(__dirname, "auth"),
    backup: path.join(__dirname, "backup"),
    media: path.join(__dirname, "media"),

    images: path.join(__dirname, "media", "images"),
    audio: path.join(__dirname, "media", "audio"),
    docs: path.join(__dirname, "media", "docs"),

    queue: path.join(__dirname, "queue"),
    webhookQueue: path.join(
        __dirname,
        "queue",
        "webhook"
    ),

    logs: path.join(__dirname, "logs")
};

Object.values(DIRS).forEach(dir => {
    fs.mkdirSync(dir, {
        recursive: true
    });
});

/* =========================================================
   LOGGING
========================================================= */

function writeLog(type, message, extra = null) {

    try {

        const line =
            `[${new Date().toISOString()}] ` +
            `${message}` +
            (extra
                ? ` ${JSON.stringify(extra)}`
                : "") +
            "\n";

        fs.appendFileSync(
            path.join(DIRS.logs, `${type}.log`),
            line
        );

    } catch (err) {
        console.error(err);
    }
}

function logInfo(msg, extra) {
    writeLog("app", msg, extra);
}

function logError(msg, extra) {
    writeLog("error", msg, extra);
}

function logWebhook(msg, extra) {
    writeLog("webhook", msg, extra);
}

function logSession(msg, extra) {
    writeLog("session", msg, extra);
}

function logBackup(msg, extra) {
    writeLog("backup", msg, extra);
}

/* =========================================================
   GLOBAL STATE
========================================================= */

const sessions = {};
const backupLocks = {};
const watchers = {};

const processedMessages =
    new Map();

/* =========================================================
   HELPERS
========================================================= */

function authPath(id) {
    return path.join(
        DIRS.auth,
        id
    );
}

function zipPath(id) {
    return path.join(
        DIRS.backup,
        `${id}.zip`
    );
}

function randomId() {

    return crypto
        .randomBytes(16)
        .toString("hex");
}

function fileExists(file) {

    try {

        return fs.existsSync(file);

    } catch {

        return false;
    }
}

function safeDelete(file) {

    try {

        fs.rmSync(file, {
            recursive: true,
            force: true
        });

    } catch {}
}

function sleep(ms) {

    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

/* =========================================================
   ZIP BACKUP ENGINE
========================================================= */

async function zipSession(sessionId) {

    return new Promise(
        (resolve, reject) => {

            const sourceDir =
                authPath(sessionId);

            if (
                !fileExists(sourceDir)
            ) {
                return reject(
                    new Error(
                        "auth folder missing"
                    )
                );
            }

            const output =
                fs.createWriteStream(
                    zipPath(sessionId)
                );

            const archive =
                archiver("zip", {
                    zlib: {
                        level: 9
                    }
                });

            output.on(
                "close",
                resolve
            );

            archive.on(
                "error",
                reject
            );

            archive.pipe(output);

            archive.directory(
                sourceDir,
                false
            );

            archive.finalize();
        }
    );
}

async function uploadBackup(
    sessionId
) {

    if (
        backupLocks[sessionId]
    ) {
        return;
    }

    backupLocks[sessionId] = true;

    try {

        const creds =
            path.join(
                authPath(sessionId),
                "creds.json"
            );

        if (
            !fileExists(creds)
        ) {

            logBackup(
                `${sessionId} skipped upload`
            );

            return;
        }

        await zipSession(
            sessionId
        );

        const form =
            new FormData();

        form.append(
            "session",
            sessionId
        );

        form.append(
            "file",
            fs.createReadStream(
                zipPath(sessionId)
            )
        );

        const response =
            await axios.post(
                `${BASE_URL}/upload.php`,
                form,
                {
                    headers:
                        form.getHeaders(),
                    timeout: 60000
                }
            );

        logBackup(
            `${sessionId} backup uploaded`,
            response.data
        );

    } catch (err) {

        logError(
            `${sessionId} backup failed`,
            {
                error:
                    err.message
            }
        );

    } finally {

        setTimeout(() => {

            backupLocks[
                sessionId
            ] = false;

        }, 5000);
    }
}

/* =========================================================
   BACKUP RESTORE
========================================================= */

async function downloadBackup(
    sessionId
) {

    try {

        const response =
            await axios.get(
                `${BASE_URL}/download.php`,
                {
                    params: {
                        session:
                            sessionId
                    },
                    responseType:
                        "stream",
                    timeout:
                        60000
                }
            );

        const zipFile =
            zipPath(sessionId);

        const writer =
            fs.createWriteStream(
                zipFile
            );

        await new Promise(
            (
                resolve,
                reject
            ) => {

                response.data.pipe(
                    writer
                );

                writer.on(
                    "finish",
                    resolve
                );

                writer.on(
                    "error",
                    reject
                );
            }
        );

        fs.mkdirSync(
            authPath(sessionId),
            {
                recursive:
                    true
            }
        );

        await fs
            .createReadStream(
                zipFile
            )
            .pipe(
                unzipper.Extract({
                    path:
                        authPath(
                            sessionId
                        )
                })
            )
            .promise();

        logBackup(
            `${sessionId} restored`
        );

        return true;

    } catch (err) {

        logBackup(
            `${sessionId} no backup`
        );

        return false;
    }
}

/* =========================================================
   WEBHOOK QUEUE
========================================================= */

async function sendWebhook(
    payload
) {

    try {

        await axios.post(
            WEBHOOK_URL,
            payload,
            {
                timeout:
                    WEBHOOK_TIMEOUT,
                headers: {
                    "Content-Type":
                        "application/json"
                }
            }
        );

        logWebhook(
            "delivered",
            {
                id:
                    payload.message_id
            }
        );

        return true;

    } catch (err) {

        logWebhook(
            "delivery failed",
            {
                id:
                    payload.message_id,
                error:
                    err.message
            }
        );

        await queueWebhook(
            payload
        );

        return false;
    }
}

async function queueWebhook(
    payload
) {

    try {

        const file =
            path.join(
                DIRS.webhookQueue,
                `${Date.now()}_${randomId()}.json`
            );

        fs.writeFileSync(
            file,
            JSON.stringify(
                payload,
                null,
                2
            )
        );

    } catch (err) {

        logError(
            "queue write failed",
            {
                error:
                    err.message
            }
        );
    }
}

async function retryWebhookQueue() {

    try {

        const files =
            fs.readdirSync(
                DIRS.webhookQueue
            );

        for (
            const file
            of files
        ) {

            try {

                const full =
                    path.join(
                        DIRS.webhookQueue,
                        file
                    );

                const payload =
                    JSON.parse(
                        fs.readFileSync(
                            full,
                            "utf8"
                        )
                    );

                await axios.post(
                    WEBHOOK_URL,
                    payload,
                    {
                        timeout:
                            WEBHOOK_TIMEOUT
                    }
                );

                fs.unlinkSync(
                    full
                );

                logWebhook(
                    "retry success",
                    {
                        file
                    }
                );

            } catch (err) {

                logWebhook(
                    "retry failed",
                    {
                        file,
                        error:
                            err.message
                    }
                );
            }
        }

    } catch (err) {

        logError(
            "queue worker failed",
            {
                error:
                    err.message
            }
        );
    }
}

setInterval(
    retryWebhookQueue,
    WEBHOOK_RETRY_INTERVAL
);

/* =========================================================
   PART 1-3 END
========================================================= */


console.log(
    "Core systems loaded"
);





/* =========================================================
   MEDIA HELPERS
========================================================= */

function mediaDir(sessionId, type) {

    const dir = path.join(
        DIRS.media,
        sessionId,
        type
    );

    fs.mkdirSync(dir, {
        recursive: true
    });

    return dir;
}

function getExtension(mime) {

    if (!mime)
        return "bin";

    const map = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "audio/ogg": "ogg",
        "audio/mpeg": "mp3",
        "audio/mp4": "m4a",
        "application/pdf": "pdf"
    };

    return map[mime] || "bin";
}

async function saveMediaFile(
    sessionId,
    type,
    buffer,
    mime
) {

    try {

        const ext =
            getExtension(mime);

        const filename =
            `${Date.now()}_${randomId()}.${ext}`;

        const filePath =
            path.join(
                mediaDir(
                    sessionId,
                    type
                ),
                filename
            );

        fs.writeFileSync(
            filePath,
            buffer
        );

        return {
            success: true,
            filename,
            path: filePath,
            mime,
            size:
                buffer.length
        };

    } catch (err) {

        logError(
            "media save failed",
            {
                error:
                    err.message
            }
        );

        return null;
    }
}

/* =========================================================
   MESSAGE TYPE DETECTION
========================================================= */

function detectMessageType(msg) {

    const m =
        msg.message || {};

    if (m.conversation)
        return "text";

    if (
        m.extendedTextMessage
    )
        return "text";

    if (
        m.imageMessage
    )
        return "image";

    if (
        m.audioMessage
    )
        return "audio";

    if (
        m.documentMessage
    )
        return "document";

    if (
        m.stickerMessage
    )
        return "sticker";

    if (
        m.locationMessage
    )
        return "location";

    if (
        m.contactMessage
    )
        return "contact";

    if (
        m.reactionMessage
    )
        return "reaction";

    if (
        m.videoMessage
    )
        return "video";

    return "unknown";
}

/* =========================================================
   TEXT EXTRACTION
========================================================= */

function extractText(msg) {

    try {

        const m =
            msg.message || {};

        if (
            m.conversation
        ) {
            return m.conversation;
        }

        if (
            m.extendedTextMessage
                ?.text
        ) {
            return m
                .extendedTextMessage
                .text;
        }

        if (
            m.imageMessage
                ?.caption
        ) {
            return m
                .imageMessage
                .caption;
        }

        if (
            m.videoMessage
                ?.caption
        ) {
            return m
                .videoMessage
                .caption;
        }

        if (
            m.documentMessage
                ?.caption
        ) {
            return m
                .documentMessage
                .caption;
        }

        return "";

    } catch {

        return "";
    }
}

/* =========================================================
   QUOTED MESSAGE
========================================================= */

function extractQuoted(msg) {

    try {

        const context =
            msg.message
                ?.extendedTextMessage
                ?.contextInfo;

        if (
            !context
        ) {
            return null;
        }

        return {
            stanzaId:
                context.stanzaId ||
                null,

            participant:
                context.participant ||
                null,

            quoted:
                context.quotedMessage ||
                null
        };

    } catch {

        return null;
    }
}

/* =========================================================
   DUPLICATE DETECTION
========================================================= */

function isDuplicate(
    messageId
) {

    if (
        processedMessages.has(
            messageId
        )
    ) {
        return true;
    }

    processedMessages.set(
        messageId,
        Date.now()
    );

    return false;
}

setInterval(() => {

    const now =
        Date.now();

    for (
        const [
            id,
            timestamp
        ]
        of processedMessages
    ) {

        if (
            now -
                timestamp >
            86400000
        ) {
            processedMessages.delete(
                id
            );
        }
    }

}, 3600000);

/* =========================================================
   MEDIA DOWNLOAD
========================================================= */

async function downloadMessageMedia(
    sessionId,
    msg
) {

    try {

        const type =
            detectMessageType(
                msg
            );

        if (
            type ===
            "video"
        ) {

            return {
                ignored:
                    true
            };
        }

        if (
            ![
                "image",
                "audio",
                "document"
            ].includes(
                type
            )
        ) {
            return null;
        }

        const buffer =
            await downloadMediaMessage(
                msg,
                "buffer",
                {},
                {
                    logger:
                        P({
                            level:
                                "silent"
                        })
                }
            );

        let mime =
            "application/octet-stream";

        if (
            type ===
            "image"
        ) {
            mime =
                msg.message
                    ?.imageMessage
                    ?.mimetype;
        }

        if (
            type ===
            "audio"
        ) {
            mime =
                msg.message
                    ?.audioMessage
                    ?.mimetype;
        }

        if (
            type ===
            "document"
        ) {
            mime =
                msg.message
                    ?.documentMessage
                    ?.mimetype;
        }

        const saved =
            await saveMediaFile(
                sessionId,
                type,
                buffer,
                mime
            );

        return saved;

    } catch (err) {

        logError(
            "media download failed",
            {
                error:
                    err.message
            }
        );

        return null;
    }
}

/* =========================================================
   PAYLOAD BUILDER
========================================================= */

async function buildPayload(
    sessionId,
    msg
) {

    const quoted =
        extractQuoted(
            msg
        );

    const media =
        await downloadMessageMedia(
            sessionId,
            msg
        );

    return {

        session_id:
            sessionId,

        message_id:
            msg.key.id,

        remote_jid:
            msg.key
                .remoteJid,

        participant:
            msg.key
                .participant ||
            null,

        from_me:
            msg.key
                .fromMe,

        push_name:
            msg.pushName ||
            null,

        timestamp:
            Number(
                msg.messageTimestamp ||
                0
            ),

        message_type:
            detectMessageType(
                msg
            ),

        text:
            extractText(
                msg
            ),

        quoted:
            quoted,

        media:
            media,

        raw: msg
    };
}

/* =========================================================
   MESSAGE PROCESSOR
========================================================= */

async function processIncomingMessage(
    sessionId,
    msg
) {

    try {

        if (
            !msg ||
            !msg.key
        ) {
            return;
        }

        const messageId =
            msg.key.id;

        if (
            !messageId
        ) {
            return;
        }

        if (
            isDuplicate(
                messageId
            )
        ) {
            return;
        }

        const payload =
            await buildPayload(
                sessionId,
                msg
            );

        await sendWebhook(
            payload
        );

        logWebhook(
            "message processed",
            {
                session:
                    sessionId,
                message:
                    messageId,
                type:
                    payload.message_type
            }
        );

    } catch (err) {

        logError(
            "process message failed",
            {
                error:
                    err.message
            }
        );
    }
}

/* =========================================================
   SESSION FILE WATCHER
========================================================= */

function watchSessionFiles(
    sessionId
) {

    if (
        watchers[
            sessionId
        ]
    ) {
        return;
    }

    const dir =
        authPath(
            sessionId
        );

    if (
        !fileExists(dir)
    ) {
        return;
    }

    watchers[
        sessionId
    ] = fs.watch(
        dir,
        async (
            event,
            file
        ) => {

            if (
                !file
            ) {
                return;
            }

            logBackup(
                `${sessionId} auth changed`
            );

            try {

                await uploadBackup(
                    sessionId
                );

            } catch (
                err
            ) {

                logError(
                    "watch backup failed",
                    {
                        session:
                            sessionId,
                        error:
                            err.message
                    }
                );
            }
        }
    );
}

/* =========================================================
   PART 4 END
========================================================= */

console.log(
    "Media engine loaded"
);
/* =========================================================
   SESSION DESTRUCTION
========================================================= */

async function destroySession(
    sessionId,
    reason = "unknown"
) {

    try {

        logSession(
            `${sessionId} destroying`,
            { reason }
        );

        try {
            watchers[sessionId]?.close();
        } catch {}

        delete watchers[sessionId];

        try {
            sessions[sessionId]
                ?.sock
                ?.end();
        } catch {}

        delete sessions[sessionId];

        safeDelete(
            authPath(sessionId)
        );

        try {

            fs.unlinkSync(
                zipPath(sessionId)
            );

        } catch {}

        logSession(
            `${sessionId} destroyed`
        );

    } catch (err) {

        logError(
            "destroy session failed",
            {
                session:
                    sessionId,
                error:
                    err.message
            }
        );
    }
}

/* =========================================================
   SESSION CREATION
========================================================= */

async function createSession(
    sessionId
) {

    if (
        sessions[
            sessionId
        ]
    ) {
        return sessions[
            sessionId
        ];
    }

    fs.mkdirSync(
        authPath(sessionId),
        {
            recursive: true
        }
    );

    try {

        const files =
            fs.readdirSync(
                authPath(
                    sessionId
                )
            );

        if (
            files.length === 0
        ) {

            await downloadBackup(
                sessionId
            );
        }

    } catch {}

    sessions[
        sessionId
    ] = {

        sessionId,

        sock: null,

        qr: null,

        connected: false,

        connecting: false,

        reconnectCount: 0,

        errorCount: 0,

        authCorrupted: false,

        lastActivity:
            Date.now(),

        lastMessage:
            0,

        lastConnection:
            0,

        webhookFailures:
            0
    };

    startSession(
        sessionId
    );

    return sessions[
        sessionId
    ];
}

/* =========================================================
   QR GENERATOR
========================================================= */

async function setQRCode(
    session,
    qr
) {

    try {

        session.qr =
            await qrcode.toDataURL(
                qr
            );

    } catch (err) {

        logError(
            "qr generation failed",
            {
                error:
                    err.message
            }
        );
    }
}

/* =========================================================
   CONNECTION FAILURE HANDLER
========================================================= */

async function handleConnectionFailure(
    sessionId,
    reason
) {

    const session =
        sessions[
            sessionId
        ];

    if (
        !session
    ) {
        return;
    }

    session.errorCount++;

    logSession(
        `${sessionId} failure`,
        {
            errors:
                session.errorCount,
            reason
        }
    );

    if (
        session.errorCount >=
        MAX_ERRORS
    ) {

        await destroySession(
            sessionId,
            "too_many_errors"
        );

        return;
    }

    setTimeout(
        () => {

            startSession(
                sessionId
            );

        },
        5000
    );
}

/* =========================================================
   BAILEYS SESSION STARTER
========================================================= */

async function startSession(
    sessionId
) {

    const session =
        sessions[
            sessionId
        ];

    if (
        !session
    ) {
        return;
    }

    if (
        session.connecting
    ) {
        return;
    }

    session.connecting =
        true;

    try {

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                authPath(
                    sessionId
                )
            );

        const {
            version
        } =
            await fetchLatestBaileysVersion();

        try {

            session.sock?.end();

        } catch {}

        const sock =
            makeWASocket({

                auth: state,

                version,

                logger: P({
                    level:
                        "silent"
                }),

                browser: [
                    "KiroFlix",
                    "Chrome",
                    "1.0"
                ],

                syncFullHistory:
                    false,

                markOnlineOnConnect:
                    false,

                generateHighQualityLinkPreview:
                    false
            });

        session.sock =
            sock;

        watchSessionFiles(
            sessionId
        );

        sock.ev.on(
            "creds.update",
            async () => {

                try {

                    await saveCreds();

                } catch (
                    err
                ) {

                    logError(
                        "save creds failed",
                        {
                            session:
                                sessionId,
                            error:
                                err.message
                        }
                    );
                }
            }
        );

        sock.ev.on(
            "connection.update",
            async update => {

                try {

                    const {
                        connection,
                        qr,
                        lastDisconnect
                    } = update;

                    if (
                        qr
                    ) {

                        await setQRCode(
                            session,
                            qr
                        );
                    }

                    if (
                        connection ===
                        "open"
                    ) {

                        session.connected =
                            true;

                        session.connecting =
                            false;

                        session.qr =
                            null;

                        session.reconnectCount =
                            0;

                        session.errorCount =
                            0;

                        session.lastConnection =
                            Date.now();

                        logSession(
                            `${sessionId} connected`
                        );

                        await uploadBackup(
                            sessionId
                        );
                    }

                    if (
                        connection ===
                        "close"
                    ) {

                        session.connected =
                            false;

                        const code =
                            lastDisconnect
                                ?.error
                                ?.output
                                ?.statusCode;

                        logSession(
                            `${sessionId} disconnected`,
                            {
                                code
                            }
                        );

                        if (
                            code ===
                            DisconnectReason.loggedOut
                        ) {

                            await destroySession(
                                sessionId,
                                "logged_out"
                            );

                            return;
                        }

                        session.reconnectCount++;

                        if (
                            session.reconnectCount >
                            MAX_RECONNECTS
                        ) {

                            await destroySession(
                                sessionId,
                                "max_reconnects"
                            );

                            return;
                        }

                        setTimeout(
                            () => {

                                startSession(
                                    sessionId
                                );

                            },
                            5000
                        );
                    }

                } catch (
                    err
                ) {

                    logError(
                        "connection handler error",
                        {
                            session:
                                sessionId,
                            error:
                                err.message
                        }
                    );
                }
            }
        );

        sock.ev.on(
            "messages.upsert",
            async ({
                messages
            }) => {

                try {

                    for (
                        const msg
                        of messages
                    ) {

                        if (
                            !msg.message
                        ) {
                            continue;
                        }

                        session.lastMessage =
                            Date.now();

                        session.lastActivity =
                            Date.now();

                        await processIncomingMessage(
                            sessionId,
                            msg
                        );
                    }

                } catch (
                    err
                ) {

                    logError(
                        "message event failed",
                        {
                            session:
                                sessionId,
                            error:
                                err.message
                        }
                    );
                }
            }
        );

        logSession(
            `${sessionId} socket started`
        );

    } catch (err) {

        session.connecting =
            false;

        logError(
            "start session failed",
            {
                session:
                    sessionId,
                error:
                    err.message
            }
        );

        await handleConnectionFailure(
            sessionId,
            err.message
        );
    } finally {

        session.connecting =
            false;
    }
}

/* =========================================================
   RESTORE ALL SESSIONS
========================================================= */

async function restoreAllSessions() {

    try {

        const response =
            await axios.get(
                `${BASE_URL}/list.php`,
                {
                    timeout:
                        60000
                }
            );

        const list =
            response.data
                ?.sessions || [];

        logSession(
            `restoring ${list.length} sessions`
        );

        for (
            const sessionId
            of list
        ) {

            try {

                await createSession(
                    sessionId
                );

                await sleep(
                    3000
                );

            } catch (
                err
            ) {

                logError(
                    "restore failed",
                    {
                        session:
                            sessionId,
                        error:
                            err.message
                    }
                );
            }
        }

    } catch (err) {

        logError(
            "restore all failed",
            {
                error:
                    err.message
            }
        );
    }
}

/* =========================================================
   PART 5 END
========================================================= */

console.log(
    "Session manager loaded"
);
/* =========================================================
   API ROUTES
========================================================= */

/*
GET /
*/

app.get("/", (req, res) => {

    res.json({
        success: true,
        service: "WhatsApp Gateway",
        uptime: process.uptime(),
        sessions:
            Object.keys(
                sessions
            ).length,
        timestamp:
            Date.now()
    });

});

/*
GET /health
*/

app.get("/health", (req, res) => {

    const memory =
        process.memoryUsage();

    res.json({

        success: true,

        uptime:
            process.uptime(),

        sessions:
            Object.keys(
                sessions
            ).length,

        memory: {

            rss:
                memory.rss,

            heapUsed:
                memory.heapUsed,

            heapTotal:
                memory.heapTotal
        },

        timestamp:
            Date.now()
    });

});

/*
GET /sessions
*/

app.get("/sessions", (req, res) => {

    const list = [];

    for (
        const [id, session]
        of Object.entries(
            sessions
        )
    ) {

        list.push({

            session:
                id,

            connected:
                session.connected,

            connecting:
                session.connecting,

            lastMessage:
                session.lastMessage,

            reconnects:
                session.reconnectCount,

            errors:
                session.errorCount
        });
    }

    res.json({
        success: true,
        total:
            list.length,
        sessions:
            list
    });

});

/*
GET /status?session=abc
*/

app.get("/status", (req, res) => {

    const sessionId =
        req.query.session;

    if (
        !sessionId
    ) {

        return res
            .status(400)
            .json({
                error:
                    "session required"
            });
    }

    const session =
        sessions[
            sessionId
        ];

    if (
        !session
    ) {

        return res.json({

            exists: false,

            connected: false,

            connecting: false
        });
    }

    res.json({

        exists: true,

        connected:
            session.connected,

        connecting:
            session.connecting,

        hasQr:
            !!session.qr,

        reconnects:
            session.reconnectCount,

        errors:
            session.errorCount
    });

});

/*
GET /qr?session=abc
*/

app.get("/qr", async (req, res) => {

    try {

        const sessionId =
            req.query.session;

        if (
            !sessionId
        ) {

            return res
                .status(400)
                .json({
                    error:
                        "session required"
                });
        }

        const session =
            await createSession(
                sessionId
            );

        await sleep(
            2000
        );

        res.json({

            success: true,

            connected:
                session.connected,

            qr:
                session.qr
        });

    } catch (err) {

        logError(
            "qr route failed",
            {
                error:
                    err.message
            }
        );

        res
            .status(500)
            .json({
                error:
                    err.message
            });
    }

});

/*
POST /send
*/

app.post("/send", async (req, res) => {

    try {

        const {
            session,
            to,
            text
        } = req.body;

        if (
            !session ||
            !to ||
            !text
        ) {

            return res
                .status(400)
                .json({
                    error:
                        "session,to,text required"
                });
        }

        const s =
            sessions[
                session
            ];

        if (
            !s ||
            !s.connected ||
            !s.sock
        ) {

            return res
                .status(400)
                .json({
                    error:
                        "session not connected"
                });
        }

        await s.sock.sendMessage(
            to,
            {
                text
            }
        );

        s.lastActivity =
            Date.now();

        res.json({
            success: true
        });

    } catch (err) {

        logError(
            "send failed",
            {
                error:
                    err.message
            }
        );

        res
            .status(500)
            .json({
                error:
                    err.message
            });
    }

});

/*
POST /logout
*/

app.post("/logout", async (req, res) => {

    try {

        const {
            session
        } = req.body;

        if (
            !session
        ) {

            return res
                .status(400)
                .json({
                    error:
                        "session required"
                });
        }

        await destroySession(
            session,
            "api_logout"
        );

        res.json({
            success: true
        });

    } catch (err) {

        logError(
            "logout failed",
            {
                error:
                    err.message
            }
        );

        res
            .status(500)
            .json({
                error:
                    err.message
            });
    }

});

/* =========================================================
   IDLE SESSION CLEANER
========================================================= */

setInterval(
    async () => {

        try {

            const now =
                Date.now();

            for (
                const [id, session]
                of Object.entries(
                    sessions
                )
            ) {

                const idle =
                    now -
                    session
                        .lastActivity;

                if (
                    idle >
                    SESSION_IDLE_TIMEOUT
                ) {

                    logSession(
                        `${id} idle cleanup`
                    );

                    await uploadBackup(
                        id
                    );

                    await destroySession(
                        id,
                        "idle_timeout"
                    );
                }
            }

        } catch (err) {

            logError(
                "idle cleaner failed",
                {
                    error:
                        err.message
                }
            );
        }

    },
    300000
);

/* =========================================================
   PROCESSED MESSAGE CLEANER
========================================================= */

setInterval(
    () => {

        try {

            const now =
                Date.now();

            for (
                const [
                    id,
                    ts
                ]
                of processedMessages
            ) {

                if (
                    now - ts >
                    86400000
                ) {

                    processedMessages.delete(
                        id
                    );
                }
            }

        } catch (
            err
        ) {

            logError(
                "message cleanup failed",
                {
                    error:
                        err.message
                }
            );
        }

    },
    3600000
);

/* =========================================================
   WEBHOOK QUEUE CLEANUP
========================================================= */

setInterval(
    () => {

        try {

            const files =
                fs.readdirSync(
                    DIRS.webhookQueue
                );

            const now =
                Date.now();

            for (
                const file
                of files
            ) {

                try {

                    const full =
                        path.join(
                            DIRS.webhookQueue,
                            file
                        );

                    const stat =
                        fs.statSync(
                            full
                        );

                    const age =
                        now -
                        stat.mtimeMs;

                    if (
                        age >
                        7 *
                            24 *
                            60 *
                            60 *
                            1000
                    ) {

                        fs.unlinkSync(
                            full
                        );
                    }

                } catch {}

            }

        } catch {}

    },
    21600000
);

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function gracefulShutdown(
    signal
) {

    logInfo(
        `shutdown ${signal}`
    );

    try {

        const ids =
            Object.keys(
                sessions
            );

        for (
            const id
            of ids
        ) {

            try {

                await uploadBackup(
                    id
                );

            } catch (
                err
            ) {

                logError(
                    "backup on shutdown failed",
                    {
                        session:
                            id,
                        error:
                            err.message
                    }
                );
            }
        }

        logInfo(
            "shutdown complete"
        );

        process.exit(
            0
        );

    } catch (err) {

        logError(
            "shutdown failed",
            {
                error:
                    err.message
            }
        );

        process.exit(
            1
        );
    }
}

process.on(
    "SIGINT",
    () =>
        gracefulShutdown(
            "SIGINT"
        )
);

process.on(
    "SIGTERM",
    () =>
        gracefulShutdown(
            "SIGTERM"
        )
);

process.on(
    "uncaughtException",
    err => {

        logError(
            "uncaught exception",
            {
                error:
                    err.stack ||
                    err.message
            }
        );
    }
);

process.on(
    "unhandledRejection",
    err => {

        logError(
            "unhandled rejection",
            {
                error:
                    err?.stack ||
                    err?.message ||
                    String(err)
            }
        );
    }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    async () => {

        logInfo(
            `server started ${PORT}`
        );

        console.log(
            `Server running on ${PORT}`
        );

        await restoreAllSessions();
    }
);

/* =========================================================
   PART 6 END
========================================================= */

console.log(
    "Gateway fully loaded"
);
