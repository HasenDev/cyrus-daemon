const { revokeUserSockets } = require('../../../client/ws/route');

module.exports = {
    POST: async (req, reply) => {
        const { userId } = req.body || {};
        if (!userId) return reply.status(400).send({ error: 'userId is required' });

        revokeUserSockets(userId);
        return reply.status(200).send({ success: true, message: `Revoked active sockets for user ${userId}` });
    }
};