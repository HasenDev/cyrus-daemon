const logger = require('./logger');
const PanelClient = require('./panelClient');
const docker = require('./docker');

async function syncNodeContainers(config) {
    if (!config.panel_url || !config.token) return;

    logger.info('Running container specification auto-sync...');

    try {
        const client = new PanelClient(config.panel_url, config.token);
        const data = await client.fetchServers();
        const serverList = data.servers || [];
        const pendingDeletions = data.pendingDeletions || [];
        const clearedDeletions = [];
        for (const uuid of pendingDeletions) {
            const containerName = `cyrus_${uuid}`;
            try {
                logger.warn(`[SYNC] Purging container ${containerName} from pending deletion queue...`);
                await docker.removeContainer(containerName, true).catch(() => {});
                clearedDeletions.push(uuid);
            } catch (err) {
                logger.error(`[SYNC] Failed to purge container ${containerName}: ${err.message}`);
            }
        }
        if (clearedDeletions.length > 0 && typeof client.ackDeletions === 'function') {
            await client.ackDeletions(clearedDeletions).catch((err) => {
                logger.error(`[SYNC] Failed to acknowledge cleared deletions to panel: ${err.message}`);
            });
        }
        for (const spec of serverList) {
            const containerName = `cyrus_${spec.uuid}`;

            try {
                const info = await docker.inspectContainer(containerName);
                const expectedMemBytes = (spec.build?.memoryLimit || 1024) * 1024 * 1024;
                const actualMemBytes = info.HostConfig?.Memory || 0;

                const isMemOut = Math.abs(expectedMemBytes - actualMemBytes) > 1024 * 1024;

                if (isMemOut) {
                    logger.warn(`[SYNC] Container ${containerName} is out of sync with Panel. Re-specifying container limits...`);

                    const primaryPort = spec.allocations?.primary?.port || 25565;
                    const envArray = [
                        'HOME=/home/container',
                        'SERVER_MEMORY=' + (spec.build?.memoryLimit || 1024),
                        'SERVER_IP=' + (spec.allocations?.primary?.ip || '0.0.0.0'),
                        'SERVER_PORT=' + String(primaryPort)
                    ];

                    if (spec.docker?.env) {
                        for (const [k, v] of Object.entries(spec.docker.env)) {
                            envArray.push(`${k}=${v !== undefined ? String(v) : ''}`);
                        }
                    }

                    const wasRunning = info.State.Running;
                    await docker.removeContainer(containerName, true).catch(() => {});

                    const newConfig = {
                        Image: spec.docker?.image || 'ubuntu:latest',
                        Cmd: spec.startup ? ['/bin/bash', '-c', spec.startup] : undefined,
                        Env: envArray,
                        WorkingDir: '/home/container',
                        HostConfig: {
                            Binds: [`/var/lib/cyruspanel/volumes/${spec.uuid}:/home/container`],
                            Memory: expectedMemBytes,
                            NanoCpus: (spec.build?.cpuLimit || 100) * 10000000,
                            NetworkMode: 'bridge',
                            PortBindings: {
                                [`${primaryPort}/tcp`]: [{ HostPort: String(primaryPort) }],
                                [`${primaryPort}/udp`]: [{ HostPort: String(primaryPort) }]
                            }
                        }
                    };

                    const newCreated = await docker.createContainer(containerName, newConfig);
                    if (wasRunning) {
                        await docker.startContainer(newCreated.Id);
                    }
                    logger.success(`[SYNC] Re-synchronized container ${containerName}`);
                }
            } catch {
            }
        }
    } catch (err) {
        logger.warn(`Auto-sync cycle encountered an issue: ${err.message}`);
    }
}

function startSyncCron(config) {
    syncNodeContainers(config);
    setInterval(() => syncNodeContainers(config), 3600000);
}

module.exports = { startSyncCron, syncNodeContainers };