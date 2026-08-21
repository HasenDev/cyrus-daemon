const fs = require('fs');
const path = require('path');
const { runServerProvisionAndInstall } = require('../../../lib/installer');

module.exports = {
    GET: async (req, reply) => {
        return reply.status(200).send({
            uuid: req.server.daemonConfig.uuid,
            servers: []
        });
    },
    POST: async (req, reply) => {
        const spec = req.body || {};
        if (!spec.id || !spec.name) {
            return reply.status(400).send({ error: 'Server ID and name required.' });
        }

        const volumeDir = path.join('/var/lib/cyruspanel/volumes', spec.id);
        if (!fs.existsSync(volumeDir)) {
            fs.mkdirSync(volumeDir, { recursive: true, mode: 0o755 });
        }

        const containerName = `cyrus_${spec.id}`;
        const panelUrl = req.server.daemonConfig.panel_url;
        const daemonToken = req.server.daemonConfig.token;
        runServerProvisionAndInstall(spec, panelUrl, daemonToken).catch(err => {
            console.error(`[Daemon Background Worker Error]: ${err.message}`);
        });
        return reply.status(201).send({
            success: true,
            message: 'Server creation accepted and queued on node daemon.',
            containerId: containerName
        });
    }
};