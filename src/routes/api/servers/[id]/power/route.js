const { handlePowerSignal } = require('../../../../client/ws/route');

module.exports = {
    POST: async (req, reply) => {
        const daemonConfig = req.server.daemonConfig || {};
        const serverId = req.params.id;
        const { action } = req.body || {};

        if (!action) {
            return reply.status(400).send({ error: 'Missing power action parameter.' });
        }
        handlePowerSignal(serverId, action, daemonConfig).catch((err) => {
            console.error(`[Cyrus Daemon Power Action Error]: ${err.message}`);
        });

        return reply.status(200).send({ success: true, message: `Action ${action} triggered.` });
    }
};