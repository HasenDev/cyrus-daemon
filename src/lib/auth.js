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

        if (token !== validToken) {
            return reply.status(403).send({ error: 'Forbidden: Invalid daemon key token.' });
        }
    };
}

module.exports = createAuthMiddleware;