const docker = require('../../../lib/docker');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const {
    BADGE_STATE,
    BADGE_INFO,
    BADGE_SUCCESS,
    BADGE_ERROR,
    normalizeUrl,
    broadcastToServer,
    revokeUserSockets,
    verifyWsToken,
    sanitizeInitialLogs,
    handleContainerExit,
    calculateMetrics,
    serverStateMap,
    diskLimitMap
} = require('./helpers');

const activeSockets = new Map();
const stopIntentMap = new Map();
const diskUsageCache = new Map();
const pendingDiskChecks = new Map();

function getFreshDiskUsageAsync(serverId) {
    if (pendingDiskChecks.has(serverId)) {
        return pendingDiskChecks.get(serverId);
    }

    const volumeDir = path.join('/var/lib/cyruspanel/volumes', serverId);
    const promise = docker.getDirectorySizeAsync(volumeDir).then((bytes) => {
        diskUsageCache.set(serverId, { size: bytes, lastCheck: Date.now() });
        pendingDiskChecks.delete(serverId);
        return bytes;
    }).catch(() => {
        pendingDiskChecks.delete(serverId);
        return diskUsageCache.get(serverId)?.size || 0;
    });

    pendingDiskChecks.set(serverId, promise);
    return promise;
}

function invalidateDiskUsage(serverId) {
    diskUsageCache.delete(serverId);
    pendingDiskChecks.delete(serverId);
}

async function handlePowerSignal(serverId, action, daemonConfig) {
    const containerName = `cyrus_${serverId}`;
    const log = (msg) => broadcastToServer(activeSockets, serverId, { event: 'console output', args: [msg + '\r\n'] });
    const setStatus = (st) => {
        serverStateMap.set(serverId, st);
        broadcastToServer(activeSockets, serverId, { event: 'status', args: [st] });
    };

    let currentState = serverStateMap.get(serverId);
    if (!currentState) {
        const info = await docker.inspectContainer(containerName).catch(() => null);
        currentState = info && info.State && info.State.Running ? 'running' : 'offline';
        serverStateMap.set(serverId, currentState);
    }

    if (currentState === 'starting' || currentState === 'stopping') {
        return;
    }

    if (currentState === 'offline') {
        if (action !== 'start') {
            return;
        }
    }

    if (currentState === 'running') {
        if (action === 'start') {
            return;
        }
    }

    if (action === 'start') {
        const existingInfo = await docker.inspectContainer(containerName).catch(() => null);
        if (existingInfo && existingInfo.State && existingInfo.State.Running) {
            log(`${BADGE_INFO}\x1b[33mServer is already running!\x1b[0m`);
            setStatus('running');
            return;
        }

        stopIntentMap.delete(serverId);
        setStatus('starting');
        log(`${BADGE_STATE}\x1b[36mServer marked as starting...\x1b[0m`);
        log(`${BADGE_INFO}Checking server disk space usage, this could take a few seconds...`);

        const panelUrl = normalizeUrl(daemonConfig.panelUrl || daemonConfig.panel_url);
        const detailsEndpoint = `${panelUrl}/api/v1/daemon/servers/${serverId}/details`;

        const isHttps = detailsEndpoint.startsWith('https');
        const agent = isHttps ? new https.Agent({ rejectUnauthorized: false }) : new http.Agent();

        const specRes = await fetch(detailsEndpoint, {
            headers: { 'Authorization': `Bearer ${daemonConfig.token}` },
            agent
        }).catch((err) => ({ ok: false, status: err.message }));

        if (!specRes.ok) {
            log(`${BADGE_ERROR}\x1b[31mFailed to fetch server details from Panel API (HTTP ${specRes.status})\x1b[0m`);
            setStatus('offline');
            log(`${BADGE_STATE}\x1b[36mServer marked as offline...\x1b[0m`);
            return;
        }

        const spec = await specRes.json();
        const volumeDir = path.join('/var/lib/cyruspanel/volumes', serverId);
        if (!fs.existsSync(volumeDir)) {
            fs.mkdirSync(volumeDir, { recursive: true, mode: 0o777 });
        }
        try {
            fs.chmodSync(volumeDir, 0o777);
        } catch (_) {}

        const currentDiskBytes = await getFreshDiskUsageAsync(serverId);
        const diskLimitMB = spec.build?.diskLimit || 5000;
        const diskLimitBytes = diskLimitMB * 1024 * 1024;

        diskLimitMap.set(serverId, diskLimitBytes);

        if (diskLimitBytes > 0 && currentDiskBytes >= diskLimitBytes) {
            log(`${BADGE_ERROR}\x1b[31mServer disk space limit reached (${(currentDiskBytes / (1024 * 1024)).toFixed(2)} MB / ${diskLimitMB} MB). Server cannot start.\x1b[0m`);
            setStatus('offline');
            log(`${BADGE_STATE}\x1b[36mServer marked as offline...\x1b[0m`);
            return;
        }

        log(`${BADGE_INFO}Updating process configuration files...`);
        log(`${BADGE_INFO}Ensuring file permissions are set correctly, this could take a few seconds...`);

        const appImage = spec.docker?.image || 'ubuntu:latest';
        log(`${BADGE_INFO}Pulling Docker container image (${appImage}), this could take a few minutes to complete...`);

        let lastLoggedProgress = '';
        await docker.pullImageWithProgress(appImage, (progressStr) => {
            if (progressStr !== lastLoggedProgress) {
                lastLoggedProgress = progressStr;
                log(`${BADGE_INFO}${progressStr}`);
            }
        }).catch(() => {});
        log(`${BADGE_SUCCESS}Finished pulling Docker container image`);

        const allAllocations = [];
        if (spec.allocations?.primary) {
            allAllocations.push(spec.allocations.primary);
        }
        if (Array.isArray(spec.allocations?.additional)) {
            allAllocations.push(...spec.allocations.additional);
        }

        const primaryPort = spec.allocations?.primary?.port || 25565;
        const primaryIp = spec.allocations?.primary?.ip || '0.0.0.0';

        const envMap = {
            HOME: '/home/container',
            SERVER_MEMORY: String(spec.build?.memoryLimit || 1024),
            SERVER_IP: primaryIp,
            SERVER_PORT: String(primaryPort),
            ...(spec.docker?.env || {})
        };

        let rawStartup = spec.startup || '';
        let resolvedStartup = rawStartup;
        if (rawStartup) {
            resolvedStartup = rawStartup.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, p1) => {
                return envMap[p1] !== undefined && envMap[p1] !== null ? String(envMap[p1]) : '';
            });
        }

        envMap['STARTUP'] = resolvedStartup;

        const appEnv = [];
        for (const [k, v] of Object.entries(envMap)) {
            appEnv.push(`${k}=${v !== undefined && v !== null ? String(v) : ''}`);
        }

        const portBindings = {};
        const exposedPorts = {};

        for (const alloc of allAllocations) {
            if (!alloc || !alloc.port) continue;
            const portStr = String(alloc.port);
            const bindIp = alloc.ip || '0.0.0.0';

            exposedPorts[`${portStr}/tcp`] = {};
            exposedPorts[`${portStr}/udp`] = {};

            portBindings[`${portStr}/tcp`] = [{ HostIp: bindIp, HostPort: portStr }];
            portBindings[`${portStr}/udp`] = [{ HostIp: bindIp, HostPort: portStr }];
        }

        const networkCfg = daemonConfig.docker?.network || {};
        const networkName = networkCfg.name || 'cyrus_nw';
        const networkMode = networkCfg.mode || networkName;
        const gatewayIp = networkCfg.interface || '172.19.0.1';
        const dnsServers = Array.isArray(networkCfg.dns) && networkCfg.dns.length > 0
            ? networkCfg.dns
            : ['1.1.1.1', '1.0.0.1'];

        if (networkMode !== 'host' && networkMode !== 'none') {
            await docker.ensureNetwork(networkName, gatewayIp).catch(() => {});
        }

        const endpointsConfig = {};
        if (networkMode !== 'host' && networkMode !== 'none' && networkMode !== 'bridge') {
            endpointsConfig[networkName] = {
                IPAMConfig: {}
            };
        }

        const memLimitBytes = (spec.build?.memoryLimit || 1024) * 1024 * 1024;
        const cpuLimitNano = (spec.build?.cpuLimit || 100) * 10000000;

        const hostConfig = {
            Binds: [`${volumeDir}:/home/container`],
            Memory: memLimitBytes,
            MemorySwap: memLimitBytes,
            NanoCpus: cpuLimitNano,
            PidsLimit: 512,
            SecurityOpt: ['no-new-privileges:true'],
            CapDrop: ['ALL', 'SYS_ADMIN', 'NET_ADMIN'],
            NetworkMode: networkMode,
            Dns: dnsServers,
            PortBindings: portBindings
        };

        const containerConfig = {
            Image: appImage,
            Env: appEnv,
            WorkingDir: '/home/container',
            Tty: true,
            OpenStdin: true,
            StdinOnce: false,
            ExposedPorts: exposedPorts,
            NetworkingConfig: Object.keys(endpointsConfig).length > 0 ? { EndpointsConfig: endpointsConfig } : undefined,
            HostConfig: hostConfig
        };

        docker.stopLiveLogStream(serverId);
        await docker.removeContainer(containerName, true).catch(() => {});
        
        let created;
        try {
            created = await docker.createContainer(containerName, containerConfig);
        } catch (err) {
            log(`${BADGE_ERROR}\x1b[31mFailed to create server container: ${err.message}\x1b[0m`);
            setStatus('offline');
            log(`${BADGE_STATE}\x1b[36mServer marked as offline...\x1b[0m`);
            return;
        }

        docker.startLiveLogStream(
            serverId,
            (text) => broadcastToServer(activeSockets, serverId, { event: 'console output', args: [text], isContainerLog: true }),
            () => handleContainerExit(serverId, activeSockets, stopIntentMap)
        );

        try {
            await docker.startContainer(created.Id);
            setStatus('running');
            log(`${BADGE_STATE}\x1b[36mServer marked as running...\x1b[0m`);
        } catch (err) {
            log(`${BADGE_ERROR}\x1b[31mFailed to start server container: ${err.message}\x1b[0m`);
            setStatus('offline');
            log(`${BADGE_STATE}\x1b[36mServer marked as offline...\x1b[0m`);
        }

    } else if (action === 'stop') {
        stopIntentMap.set(serverId, 'stop');
        setStatus('stopping');
        log(`${BADGE_STATE}\x1b[36mServer marked as stopping...\x1b[0m`);
        await docker.stopContainer(containerName, 10).catch(() => {});

    } else if (action === 'restart') {
        stopIntentMap.set(serverId, 'restart');
        setStatus('stopping');
        log(`${BADGE_STATE}\x1b[36mServer marked as restarting...\x1b[0m`);

        docker.stopLiveLogStream(serverId);
        await docker.stopContainer(containerName, 10).catch(() => {});

        setStatus('starting');

        docker.startLiveLogStream(
            serverId,
            (text) => broadcastToServer(activeSockets, serverId, { event: 'console output', args: [text], isContainerLog: true }),
            () => handleContainerExit(serverId, activeSockets, stopIntentMap)
        );

        await docker.startContainer(containerName).catch(async () => {
            await docker.restartContainer(containerName, 5).catch(() => {});
        });

        stopIntentMap.delete(serverId);
        setStatus('running');
        log(`${BADGE_STATE}\x1b[36mServer marked as running...\x1b[0m`);

    } else if (action === 'kill') {
        stopIntentMap.set(serverId, 'kill');
        setStatus('stopping');
        log(`${BADGE_ERROR}\x1b[31mServer process forcibly killed...\x1b[0m`);
        await docker.killContainer(containerName).catch(() => {});
    }
}

async function clientWsRoute(ws, req, daemonConfig) {
    const rawUrl = req.url || '';
    const queryString = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
    const urlParams = new URLSearchParams(queryString);

    const token = urlParams.get('token');
    const serverId = urlParams.get('server');

    if (!token || !serverId) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ 
                event: 'jwt error', 
                args: [`${BADGE_ERROR}\x1b[31mMissing authentication parameters.\x1b[0m\r\n`] 
            }));
        }
        ws.close(4003, 'Unauthorized');
        return;
    }

    let authenticatedUserId = null;

    try {
        const verifyData = await verifyWsToken(daemonConfig.panelUrl || daemonConfig.panel_url, daemonConfig.token, token, serverId);
        if (!verifyData.valid) {
            if (verifyData.reason === 'PASSWORD_CHANGED') {
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ 
                        event: 'jwt error', 
                        args: [`${BADGE_ERROR}\x1b[31mPassword was updated. Disconnecting...\x1b[0m\r\n`] 
                    }));
                }
                return ws.close(4001, 'Password Changed');
            }
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({ 
                    event: 'jwt error', 
                    args: [`${BADGE_ERROR}\x1b[31mInvalid or expired authentication token.\x1b[0m\r\n`] 
                }));
            }
            return ws.close(4003, 'Invalid Token');
        }

        authenticatedUserId = verifyData.userId;

        ws.canConsole = verifyData.canConsole === true;
        ws.canPower = verifyData.canPower === true;
    } catch (err) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ 
                event: 'jwt error', 
                args: [`${BADGE_ERROR}\x1b[31mCould not reach Panel API (${err.message}).\x1b[0m\r\n`] 
            }));
        }
        return ws.close(4002, 'Auth Unreachable');
    }

    ws.userId = authenticatedUserId;
    ws.serverId = serverId;

    if (!activeSockets.has(serverId)) activeSockets.set(serverId, new Set());
    activeSockets.get(serverId).add(ws);

    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ event: 'auth success' }));
    }

    const containerName = `cyrus_${serverId}`;

    try {
        const info = await docker.inspectContainer(containerName);
        const isRunning = Boolean(info && info.State && info.State.Running);
        const currentState = serverStateMap.get(serverId) || (isRunning ? 'running' : 'offline');
        serverStateMap.set(serverId, currentState);

        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ event: 'status', args: [currentState] }));
            ws.send(JSON.stringify({
                event: 'console output',
                args: [`${BADGE_STATE}\x1b[36mServer marked as ${currentState}...\x1b[0m\r\n`]
            }));

            if (!ws.canConsole) {
                ws.send(JSON.stringify({
                    event: 'console output',
                    args: [`${BADGE_INFO}\x1b[33mYou do not have permission to view server console logs or execute commands, therefore they will be hidden.\x1b[0m\r\n`]
                }));
            }
        }

        if (isRunning) {
            if (ws.canConsole) {
                const initialLogsRaw = await docker.getContainerLogs(containerName, 100).catch(() => '');
                const trimmedLogs = sanitizeInitialLogs(initialLogsRaw, 100, 65536);
                if (trimmedLogs && ws.readyState === 1) {
                    ws.send(JSON.stringify({ event: 'console output', args: [trimmedLogs], isContainerLog: true }));
                }
            }

            if (!docker.isStreamAttached(serverId)) {
                docker.startLiveLogStream(
                    serverId,
                    (text) => broadcastToServer(activeSockets, serverId, { event: 'console output', args: [text], isContainerLog: true }),
                    () => handleContainerExit(serverId, activeSockets, stopIntentMap)
                );
            }
        }
    } catch {
        const state = serverStateMap.get(serverId) || 'offline';
        serverStateMap.set(serverId, state);
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ event: 'status', args: [state] }));
            ws.send(JSON.stringify({
                event: 'console output',
                args: [`${BADGE_STATE}\x1b[36mServer marked as ${state}...\x1b[0m\r\n`]
            }));

            if (!ws.canConsole) {
                ws.send(JSON.stringify({
                    event: 'console output',
                    args: [`${BADGE_INFO}\x1b[33mYou do not have permission to view server console logs or execute commands, therefore they will be hidden.\x1b[0m\r\n`]
                }));
            }
        }
    }

    const statsInterval = setInterval(async () => {
        if (ws.readyState !== 1) return;
        try {
            const [stats, info, diskBytes] = await Promise.all([
                docker.getContainerStats(containerName).catch(() => null),
                docker.inspectContainer(containerName).catch(() => null),
                getFreshDiskUsageAsync(serverId)
            ]);

            const metrics = calculateMetrics(stats, info, serverId);
            metrics.disk_bytes = diskBytes;
            
            const limitBytes = diskLimitMap.get(serverId) || 0;
            const currentState = serverStateMap.get(serverId);

            if (limitBytes > 0 && metrics.disk_bytes > limitBytes) {
                if (currentState === 'running' || currentState === 'starting') {
                    if (!stopIntentMap.has(serverId)) {
                        stopIntentMap.set(serverId, 'kill');
                        serverStateMap.set(serverId, 'stopping');
                        
                        broadcastToServer(activeSockets, serverId, { event: 'status', args: ['stopping'] });
                        broadcastToServer(activeSockets, serverId, {
                            event: 'console output',
                            args: [`${BADGE_ERROR}\x1b[31mServer exceeded its allowed disk space limit (${(metrics.disk_bytes / 1024 / 1024).toFixed(2)} MB / ${(limitBytes / 1024 / 1024).toFixed(2)} MB). Forcibly stopping...\x1b[0m\r\n`]
                        });

                        docker.killContainer(containerName).catch(() => {});
                    }
                }
            }

            if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                    event: 'stats',
                    args: [JSON.stringify(metrics)]
                }));
            }
        } catch (_) {}
    }, 1000);

    ws.on('message', async (data) => {
        try {
            const parsed = JSON.parse(data.toString());
            if (parsed.event === 'ping') {
                if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'pong' }));
                return;
            }

            if (parsed.event === 'send command') {
                if (!ws.canConsole || serverStateMap.get(serverId) === 'offline') {
                    return;
                }

                let command = '';
                if (Array.isArray(parsed.args)) {
                    command = parsed.args.join(' ');
                } else if (typeof parsed.args === 'string') {
                    command = parsed.args;
                }

                if (!command && command !== '0') return;

                await docker.writeContainerStdin(serverId, command);
            }

            if (parsed.event === 'set state' && parsed.args && parsed.args[0]) {
                if (!ws.canPower) return;
                await handlePowerSignal(serverId, parsed.args[0], daemonConfig);
            }
        } catch (_) {}
    });

    ws.on('close', () => {
        clearInterval(statsInterval);
        const set = activeSockets.get(serverId);
        if (set) {
            set.delete(ws);
            if (set.size === 0) activeSockets.delete(serverId);
        }
    });
}

module.exports = clientWsRoute;
module.exports.broadcastToServer = (serverId, payload) => broadcastToServer(activeSockets, serverId, payload);
module.exports.revokeUserSockets = (userId) => revokeUserSockets(activeSockets, userId);
module.exports.handlePowerSignal = handlePowerSignal;
module.exports.invalidateDiskUsage = invalidateDiskUsage;
module.exports.getFreshDiskUsageAsync = getFreshDiskUsageAsync;
