const { runServerProvisionAndInstall } = require('../../../../../lib/installer');

module.exports = {
    POST: async (req, reply) => {
        const serverId = req.params.id;
        const spec = req.body || {};

        if (!serverId) {
            return reply.status(400).send({ error: 'Server ID parameter is required.' });
        }

        spec.id = serverId;

        const panelUrl = req.server.daemonConfig.panel_url;
        const daemonToken = req.server.daemonConfig.token;
        runServerProvisionAndInstall(spec, panelUrl, daemonToken).catch((err) => {
            console.error(`[Daemon Reinstall Worker Error - ${serverId}]:`, err.message);
        });

        return reply.status(202).send({
            success: true,
            message: 'Server reinstallation initiated on node daemon.'
        });
    }
};