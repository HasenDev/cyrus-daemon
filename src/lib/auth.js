const crypto = require('crypto');

function createAuthMiddleware(validToken) {
    return async function authenticate(req, reply) {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return reply.status(401).send({ error: 'Unauthorized: Missing Authorization header.' });
        }

        let token = authHeader;
        if (token.startsWith('Bearer ')) {
            token = token.slice(7);
        }

        if (!validToken || typeof token !== 'string') {
            return reply.status(403).send({ error: 'Forbidden: Invalid daemon key token.' });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest();
        const validTokenHash = crypto.createHash('sha256').update(String(validToken)).digest();

        if (!crypto.timingSafeEqual(tokenHash, validTokenHash)) {
            return reply.status(403).send({ error: 'Forbidden: Invalid daemon key token.' });
        }
    };
}

module.exports = createAuthMiddleware;
