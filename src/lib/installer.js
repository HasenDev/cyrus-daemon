const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const docker = require('./docker');

async function runServerProvisionAndInstall(serverSpec, panelUrl, daemonToken) {
    const volumeDir = path.join('/var/lib/cyruspanel/volumes', serverSpec.id);
    const containerName = `cyrus_${serverSpec.id}`;

    try {
        if (!fs.existsSync(volumeDir)) {
            fs.mkdirSync(volumeDir, { recursive: true, mode: 0o755 });
        }
        const scriptObj = serverSpec.eggScript?.installation || serverSpec.eggScript || {};
        const rawScript = scriptObj.script || '';
        const installImage = scriptObj.container || 'python:3.8-slim-bookworm';
        const entrypointBin = scriptObj.entrypoint || 'bash';
        if (rawScript && rawScript.trim()) {
            logger.info(`Pulling installer image ${logger.accent(installImage)} for server ${serverSpec.id}...`);
            await docker.pullImage(installImage).catch(e => {
                logger.warn(`Image pull warning for ${installImage}: ${e.message}`);
            });
            const cleanScript = rawScript.replace(/\r\n/g, '\n');
            const scriptPath = path.join(volumeDir, '_cyrus_install.sh');
            fs.writeFileSync(scriptPath, cleanScript, { mode: 0o755 });

            logger.info(`Starting installation container for ${logger.bold(serverSpec.id)}...`);

            const installerContainerName = `cyrus_install_${serverSpec.id}`;
            const envArray = [
                'HOME=/mnt/server',
                'SERVER_MEMORY=' + (serverSpec.memory || 1024),
                'SERVER_IP=' + (serverSpec.allocations?.primary?.ip || '0.0.0.0'),
                'SERVER_PORT=' + (serverSpec.allocations?.primary?.port || 25565)
            ];

            if (serverSpec.env && typeof serverSpec.env === 'object') {
                for (const [k, v] of Object.entries(serverSpec.env)) {
                    envArray.push(`${k}=${v !== undefined && v !== null ? String(v) : ''}`);
                }
            }

            const installerConfig = {
                Image: installImage,
                Entrypoint: [entrypointBin],
                Cmd: ['/mnt/server/_cyrus_install.sh'],
                Env: envArray,
                WorkingDir: '/mnt/server',
                HostConfig: {
                    Binds: [`${volumeDir}:/mnt/server`],
                    NetworkMode: 'bridge'
                }
            };

            const createdInstall = await docker.createContainer(installerContainerName, installerConfig);
            await docker.startContainer(createdInstall.Id);
            await new Promise((resolve) => {
                const checkInterval = setInterval(async () => {
                    try {
                        const info = await docker.inspectContainer(createdInstall.Id);
                        if (!info.State.Running) {
                            clearInterval(checkInterval);
                            await docker.removeContainer(createdInstall.Id, true).catch(() => {});
                            if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

                            const isSuccess = info.State.ExitCode === 0;
                            if (isSuccess) {
                                logger.success(`Egg installation finished for ${logger.bold(serverSpec.id)}`);
                            } else {
                                logger.error(`Egg installation failed for ${serverSpec.id} (Exit Code: ${info.State.ExitCode})`);
                            }
                            resolve(isSuccess);
                        }
                    } catch {
                        clearInterval(checkInterval);
                        resolve(false);
                    }
                }, 2500);
            });
        }
        logger.info(`Preparing main application container for ${logger.bold(serverSpec.id)}...`);
        const appImage = serverSpec.dockerImage || 'ubuntu:latest';
        await docker.pullImage(appImage).catch(() => {});

        const primaryPort = serverSpec.allocations?.primary?.port || 25565;
        const appEnv = [
            'HOME=/home/container',
            'SERVER_MEMORY=' + (serverSpec.memory || 1024),
            'SERVER_IP=' + (serverSpec.allocations?.primary?.ip || '0.0.0.0'),
            'SERVER_PORT=' + String(primaryPort)
        ];

        if (serverSpec.env && typeof serverSpec.env === 'object') {
            for (const [k, v] of Object.entries(serverSpec.env)) {
                appEnv.push(`${k}=${v !== undefined && v !== null ? String(v) : ''}`);
            }
        }

        const containerConfig = {
            Image: appImage,
            Cmd: serverSpec.startup ? ['/bin/bash', '-c', serverSpec.startup] : undefined,
            Env: appEnv,
            WorkingDir: '/home/container',
            HostConfig: {
                Binds: [`${volumeDir}:/home/container`],
                Memory: (serverSpec.memory || 1024) * 1024 * 1024,
                NanoCpus: (serverSpec.cpu || 100) * 10000000,
                NetworkMode: 'bridge',
                PortBindings: {
                    [`${primaryPort}/tcp`]: [{ HostPort: String(primaryPort) }],
                    [`${primaryPort}/udp`]: [{ HostPort: String(primaryPort) }]
                }
            }
        };
        await docker.removeContainer(containerName, true).catch(() => {});
        await docker.createContainer(containerName, containerConfig);
        await notifyPanelInstallation(panelUrl, daemonToken, serverSpec.id, 'completed');
    } catch (err) {
        logger.error(`Server background provisioner exception for ${serverSpec.id}: ${err.message}`);
        await notifyPanelInstallation(panelUrl, daemonToken, serverSpec.id, 'failed');
    }
}

async function notifyPanelInstallation(panelUrl, daemonToken, serverId, status) {
    if (!panelUrl) return;

    try {
        const url = `${panelUrl.replace(/\/+$/, '')}/api/v1/admin/servers/manage`;
        await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${daemonToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ serverId, status })
        });
    } catch {
    }
}

module.exports = { runServerProvisionAndInstall };