const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { resolveSafePath } = require('../../../../../lib/files');

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

        const maxLimitMB = typeof payload.maxSizeMB === 'number' && payload.maxSizeMB > 0 
            ? payload.maxSizeMB 
            : 100;
        const maxUploadBytes = maxLimitMB * 1024 * 1024;
        let totalBytes = 0;

        try {
            const parts = req.parts();
            let uploadDir = payload.directory || '/';

            for await (const part of parts) {
                if (part.type === 'field' && part.fieldname === 'directory') {
                    uploadDir = part.value || uploadDir;
                } else if (part.type === 'file') {
                    const filename = part.filename || `upload_${Date.now()}`;
                    const { targetPath } = resolveSafePath(payload.serverId, path.join(uploadDir, filename));

                    const parentDir = path.dirname(targetPath);
                    if (!fs.existsSync(parentDir)) {
                        fs.mkdirSync(parentDir, { recursive: true, mode: 0o777 });
                    }

                    await new Promise((resolve, reject) => {
                        const ws = fs.createWriteStream(targetPath);
                        let sizeExceeded = false;

                        part.file.on('data', (chunk) => {
                            totalBytes += chunk.length;
                            if (totalBytes > maxUploadBytes) {
                                sizeExceeded = true;
                                part.file.destroy();
                                ws.destroy();
                                if (fs.existsSync(targetPath)) {
                                    try { fs.unlinkSync(targetPath); } catch (_) {}
                                }
                                reject(new Error('EXCEEDS_LIMIT'));
                            }
                        });

                        part.file.on('error', (err) => {
                            if (!sizeExceeded) {
                                ws.destroy();
                                if (fs.existsSync(targetPath)) {
                                    try { fs.unlinkSync(targetPath); } catch (_) {}
                                }
                                reject(err);
                            }
                        });

                        ws.on('error', (err) => {
                            if (!sizeExceeded) {
                                part.file.destroy();
                                if (fs.existsSync(targetPath)) {
                                    try { fs.unlinkSync(targetPath); } catch (_) {}
                                }
                                reject(err);
                            }
                        });

                        ws.on('finish', () => {
                            if (!sizeExceeded) resolve();
                        });

                        part.file.pipe(ws);
                    });
                }
            }

            return reply.status(200).send({ success: true, message: 'File(s) uploaded successfully directly to daemon.' });
        } catch (err) {
            if (err.message === 'EXCEEDS_LIMIT') {
                return reply.status(413).send({
                    error: `Upload rejected: Exceeds maximum allowed size limit of ${maxLimitMB} MB.`
                });
            }
            return reply.status(500).send({ error: 'Upload failed: Server disk error.' });
        }
    }
};
