const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { resolveSafePath, getMimeType } = require('../../../../../lib/files');

module.exports = {
    GET: async (req, reply) => {
        const token = req.query.token;
        if (!token) return reply.status(401).send({ error: 'Missing download token.' });

        const daemonConfig = req.server.daemonConfig;
        let payload;
        try {
            payload = jwt.verify(token, daemonConfig.token);
        } catch {
            return reply.status(403).send({ error: 'Invalid or expired download token (5h limit exceeded).' });
        }

        if (payload.action !== 'download' || !payload.serverId || !payload.file) {
            return reply.status(400).send({ error: 'Invalid token payload.' });
        }

        try {
            const { targetPath } = resolveSafePath(payload.serverId, payload.file);
            if (!fs.existsSync(targetPath)) {
                return reply.status(404).send({ error: 'File not found on disk.' });
            }

            const stat = fs.statSync(targetPath);
            if (stat.isDirectory()) {
                return reply.status(400).send({ error: 'Directories cannot be downloaded directly.' });
            }

            const fileName = path.basename(targetPath);
            reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
            reply.header('Content-Type', getMimeType(fileName) || 'application/octet-stream');
            reply.header('Content-Length', stat.size);

            return reply.send(fs.createReadStream(targetPath));
        } catch (err) {
            return reply.status(500).send({ error: 'Failed to stream requested file.' });
        }
    }
};