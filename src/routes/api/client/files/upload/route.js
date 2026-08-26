const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const docker = require('../../../../../lib/docker');
const { resolveSafePath } = require('../../../../../lib/files');

const serverReservations = new Map();
const serverLimitCache = new Map();
const serverUsageCache = new Map();
const serverLocks = new Map();

class Mutex {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    acquire() {
        return new Promise((resolve) => {
            if (!this._locked) {
                this._locked = true;
                return resolve(this._release.bind(this));
            }
            this._queue.push(resolve);
        });
    }

    _release() {
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            next(this._release.bind(this));
        } else {
            this._locked = false;
        }
    }
}

function getServerMutex(serverId) {
    let mutex = serverLocks.get(serverId);
    if (!mutex) {
        mutex = new Mutex();
        serverLocks.set(serverId, mutex);
    }
    return mutex;
}

async function withServerLock(serverId, fn) {
    const mutex = getServerMutex(serverId);
    const release = await mutex.acquire();
    try {
        return await fn();
    } finally {
        release();
    }
}

function getTotalReserved(serverId, excludeUploadId = null) {
    const resMap = serverReservations.get(serverId);
    if (!resMap) return 0;
    let total = 0;
    for (const [id, bytes] of resMap.entries()) {
        if (id !== excludeUploadId) {
            total += bytes;
        }
    }
    return total;
}

function setReservation(serverId, uploadId, bytes) {
    if (!serverReservations.has(serverId)) {
        serverReservations.set(serverId, new Map());
    }
    serverReservations.get(serverId).set(uploadId, bytes);
}

function releaseReservation(serverId, uploadId) {
    const resMap = serverReservations.get(serverId);
    if (resMap) {
        resMap.delete(uploadId);
        if (resMap.size === 0) {
            serverReservations.delete(serverId);
        }
    }
}

async function getTrustedDiskLimit(serverId, daemonConfig) {
    const panelUrl = (daemonConfig.panelUrl || daemonConfig.panel_url || '').replace(/\/+$/, '');
    if (panelUrl) {
        const detailsEndpoint = `${panelUrl}/api/v1/daemon/servers/${serverId}/details`;
        const isHttps = detailsEndpoint.startsWith('https');
        const agent = isHttps ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent();

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const specRes = await fetch(detailsEndpoint, {
                headers: { 'Authorization': `Bearer ${daemonConfig.token}` },
                agent,
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (specRes.ok) {
                const spec = await specRes.json();
                const diskLimitMB = Number(spec?.build?.diskLimit);
                if (!isNaN(diskLimitMB) && diskLimitMB > 0) {
                    const limitBytes = diskLimitMB * 1024 * 1024;
                    serverLimitCache.set(serverId, { limitBytes, updatedAt: Date.now() });
                    return limitBytes;
                }
            }
        } catch (_) {}
    }

    const cached = serverLimitCache.get(serverId);
    if (cached && (Date.now() - cached.updatedAt) < 10 * 60 * 1000) {
        return cached.limitBytes;
    }

    return null;
}

async function getActualUsage(serverId, forceFresh = false) {
    const cached = serverUsageCache.get(serverId);
    if (!forceFresh && cached && (Date.now() - cached.updatedAt) < 1000) {
        return cached.bytes;
    }

    const volumeDir = path.join('/var/lib/cyruspanel/volumes', serverId);
    let bytes = 0;
    try {
        bytes = await docker.getDirectorySizeAsync(volumeDir);
    } catch {
        bytes = 0;
    }

    serverUsageCache.set(serverId, { bytes, updatedAt: Date.now() });
    return bytes;
}

async function atomicCheckAndReserve(serverId, uploadId, requiredNetIncrease, diskLimitBytes, forceFreshUsage = false) {
    return await withServerLock(serverId, async () => {
        const currentUsage = await getActualUsage(serverId, forceFreshUsage);
        const otherReserved = getTotalReserved(serverId, uploadId);

        if (currentUsage + otherReserved + requiredNetIncrease > diskLimitBytes) {
            return false;
        }

        setReservation(serverId, uploadId, requiredNetIncrease);
        return true;
    });
}

module.exports = {
    POST: async (req, reply) => {
        const authHeader = req.headers.authorization || req.headers.Authorization;
        let token = authHeader;
        if (token && token.startsWith('Bearer ')) {
            token = token.slice(7);
        }

        if (!token) {
            token = req.query?.token;
        }

        if (!token) return reply.status(401).send({ error: 'Missing upload token.' });

        const daemonConfig = req.server.daemonConfig;
        let payload;
        try {
            payload = jwt.verify(token, daemonConfig.token);
        } catch {
            return reply.status(403).send({ error: 'Invalid or expired upload token.' });
        }

        if (payload.action !== 'upload' || !payload.serverId) {
            return reply.status(400).send({ error: 'Invalid token payload.' });
        }

        if (!req.isMultipart || !req.isMultipart()) {
            return reply.status(400).send({ error: 'Invalid request: Expected multipart form-data.' });
        }

        const serverId = payload.serverId;
        const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const diskLimitBytes = await getTrustedDiskLimit(serverId, daemonConfig);
        if (diskLimitBytes === null) {
            return reply.status(503).send({ error: 'Cannot determine server storage limit. Upload rejected.' });
        }

        const initialAvailable = await atomicCheckAndReserve(serverId, uploadId, 0, diskLimitBytes, true);
        if (!initialAvailable) {
            return reply.status(413).send({ error: 'Upload rejected: Server disk storage limit reached or exceeded.' });
        }

        const maxLimitMB = typeof payload.maxSizeMB === 'number' && payload.maxSizeMB > 0 
            ? payload.maxSizeMB 
            : 100;
        const maxUploadBytes = maxLimitMB * 1024 * 1024;
        let totalUploadedBytes = 0;
        let activeTempFiles = [];

        try {
            const parts = req.parts();
            let uploadDir = payload.directory || '/';

            for await (const part of parts) {
                if (part.type === 'field' && part.fieldname === 'directory') {
                    uploadDir = part.value || uploadDir;
                } else if (part.type === 'file') {
                    const filename = part.filename || `upload_${Date.now()}`;
                    const { targetPath } = resolveSafePath(serverId, path.join(uploadDir, filename));

                    const parentDir = path.dirname(targetPath);
                    if (!fs.existsSync(parentDir)) {
                        fs.mkdirSync(parentDir, { recursive: true, mode: 0o777 });
                    }

                    let existingFileSize = 0;
                    if (fs.existsSync(targetPath)) {
                        try {
                            const lstat = fs.lstatSync(targetPath);
                            if (lstat.isFile() && !lstat.isSymbolicLink()) {
                                existingFileSize = lstat.size;
                            }
                        } catch (_) {}
                    }

                    const tempUploadPath = `${targetPath}.upload_${uploadId}`;
                    activeTempFiles.push(tempUploadPath);

                    let fileBytes = 0;
                    let fd = null;

                    try {
                        fd = fs.openSync(tempUploadPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o666);

                        for await (const chunk of part.file) {
                            fileBytes += chunk.length;
                            totalUploadedBytes += chunk.length;

                            if (totalUploadedBytes > maxUploadBytes) {
                                throw new Error('JWT_LIMIT_EXCEEDED');
                            }

                            const netIncrease = Math.max(0, fileBytes - existingFileSize);
                            const reservedOk = await atomicCheckAndReserve(serverId, uploadId, netIncrease, diskLimitBytes, false);

                            if (!reservedOk) {
                                throw new Error('STORAGE_LIMIT_EXCEEDED');
                            }

                            await new Promise((resolve, reject) => {
                                fs.write(fd, chunk, 0, chunk.length, null, (err) => {
                                    if (err) return reject(err);
                                    resolve();
                                });
                            });
                        }

                        fs.closeSync(fd);
                        fd = null;

                        if (fs.existsSync(targetPath)) {
                            fs.rmSync(targetPath, { force: true });
                        }
                        fs.renameSync(tempUploadPath, targetPath);
                        activeTempFiles = activeTempFiles.filter(p => p !== tempUploadPath);
                    } catch (fileErr) {
                        if (fd !== null) {
                            try { fs.closeSync(fd); } catch (_) {}
                        }
                        if (fs.existsSync(tempUploadPath)) {
                            try { fs.unlinkSync(tempUploadPath); } catch (_) {}
                        }
                        throw fileErr;
                    }
                }
            }

            return reply.status(200).send({ success: true, message: 'File(s) uploaded successfully directly to daemon.' });
        } catch (err) {
            for (const tmp of activeTempFiles) {
                if (fs.existsSync(tmp)) {
                    try { fs.unlinkSync(tmp); } catch (_) {}
                }
            }
            if (err.message === 'JWT_LIMIT_EXCEEDED') {
                return reply.status(413).send({
                    error: `Upload rejected: Exceeds maximum allowed size limit of ${maxLimitMB} MB.`
                });
            }
            if (err.message === 'STORAGE_LIMIT_EXCEEDED') {
                return reply.status(413).send({
                    error: 'Upload rejected: Server disk storage limit reached or exceeded.'
                });
            }
            return reply.status(500).send({ error: 'Upload failed: Server disk error.' });
        } finally {
            releaseReservation(serverId, uploadId);
            serverUsageCache.delete(serverId);
        }
    }
};
