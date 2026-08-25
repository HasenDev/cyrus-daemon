const docker = require('../../../../lib/docker');
const fs = require('fs');
const path = require('path');

const SERVER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

module.exports = {
    GET: async (req, reply) => {
        const serverId = req.params?.id;

        if (!serverId || !SERVER_ID_REGEX.test(serverId)) {
            return reply.status(400).send({ error: 'Invalid server identifier.' });
        }

        const containerName = `cyrus_${serverId}`;

        try {
            const info = await docker.inspectContainer(containerName);
            let status = 'offline';

            if (info.State.Running) status = 'running';
            else if (info.State.Restarting) status = 'starting';

            return reply.status(200).send({
                serverId,
                status
            });
        } catch {
            return reply.status(200).send({
                serverId,
                status: 'offline'
            });
        }
    },
    DELETE: async (req, reply) => {
        const serverId = req.params?.id;

        if (!serverId || !SERVER_ID_REGEX.test(serverId)) {
            return reply.status(400).send({ error: 'Invalid server identifier.' });
        }

        const containerName = `cyrus_${serverId}`;
        const volumeDir = path.join('/var/lib/cyruspanel/volumes', serverId);

        try {
            await docker.removeContainer(containerName, true).catch(() => {});

            if (fs.existsSync(volumeDir)) {
                fs.rmSync(volumeDir, { recursive: true, force: true });
            }

            return reply.status(200).send({
                success: true,
                message: `Server container ${serverId} and volume purged.`
            });
        } catch (err) {
            return reply.status(500).send({ error: `Failed to remove container: ${err.message}` });
        }
    }
};
