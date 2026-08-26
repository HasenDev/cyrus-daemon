const crypto = require('crypto');
const { revokeUserSockets } = require('../../../client/ws/route');

module.exports = {
    POST: async (req, reply) => {
        const authHeader = req.headers.authorization || req.headers.Authorization;
        if (!authHeader) {
            return reply.status(401).send({ error: 'Daemon authorization token required.' });
        }

        let token = authHeader;
        if (token.startsWith('Bearer ')) {
            token = token.slice(7);
        }

        const daemonConfig = req.server.daemonConfig;
        if (!daemonConfig || !daemonConfig.token) {
            return reply.status(500).send({ error: 'Daemon configuration missing.' });
        }

        const tokenHash = crypto.createHash('sha256').update(String(token)).digest();
        const validTokenHash = crypto.createHash('sha256').update(String(daemonConfig.token)).digest();

        if (!crypto.timingSafeEqual(tokenHash, validTokenHash)) {
            return reply.status(403).send({ error: 'Forbidden: Invalid daemon authentication token.' });
        }

        const { userId } = req.body || {};
        if (!userId || typeof userId !== 'string' || !userId.trim()) {
            return reply.status(400).send({ error: 'Valid userId string is required.' });
        }

        const cleanUserId = userId.trim();
        if (cleanUserId.length > 128) {
            return reply.status(400).send({ error: 'Invalid userId format.' });
        }

        revokeUserSockets(cleanUserId);
        return reply.status(200).send({ success: true, message: `Revoked active sockets for user ${cleanUserId}` });
    }
};
