const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { resolveSafePath } = require('../../../../../lib/files');

module.exports = {
    POST: async (req, reply) => {
        const token = req.query.token;
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
                        part.file.pipe(ws);
                        ws.on('finish', resolve);
                        ws.on('error', reject);
                    });
                }
            }

            return reply.status(200).send({ success: true, message: 'File(s) uploaded successfully directly to daemon.' });
        } catch (err) {
            return reply.status(500).send({ error: 'Upload failed: Server disk error.' });
        }
    }
};