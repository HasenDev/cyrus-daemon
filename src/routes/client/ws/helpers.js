const http = require('http');
const https = require('https');
const docker = require('../../../lib/docker');

const BADGE_STATE   = '\x1b[46;37;1m [Cyrus Daemon] \x1b[0m ';
const BADGE_INFO    = '\x1b[43;37;1m [Cyrus Daemon] \x1b[0m ';
const BADGE_SUCCESS = '\x1b[42;37;1m [Cyrus Daemon] \x1b[0m ';
const BADGE_ERROR   = '\x1b[41;37;1m [Cyrus Daemon] \x1b[0m ';

const serverStateMap = new Map();
const diskLimitMap = new Map();

function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return 'http://127.0.0.1:3000';
    let url = rawUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) {
        url = 'http://' + url;
    }
    return url;
}

function broadcastToServer(activeSockets, serverId, payload) {
    const sockets = activeSockets.get(serverId);
    if (sockets) {
        const message = JSON.stringify(payload);
        const isContainerLog = payload && payload.isContainerLog === true;

        for (const ws of sockets) {
            if (ws.readyState === 1) {
                if (isContainerLog && ws.canConsole === false) {
                    continue;
                }
                ws.send(message);
            }
        }
    }
}

function revokeUserSockets(activeSockets, userId) {
    for (const [serverId, sockets] of activeSockets.entries()) {
        for (const ws of sockets) {
            if (ws.userId === userId) {
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ 
                        event: 'jwt error', 
                        args: [`\r\n${BADGE_ERROR}\x1b[31mPassword was updated. Disconnecting...\x1b[0m\r\n`] 
                    }));
                }
                ws.close(4001, 'Password Changed');
            }
        }
    }
}

async function verifyWsToken(panelUrl, daemonToken, token, serverId) {
    const baseUrl = normalizeUrl(panelUrl);
    const verifyEndpoint = `${baseUrl}/api/v1/daemon/verify-ws-token`;
    const isHttps = verifyEndpoint.startsWith('https');

    if (typeof fetch === 'function') {
        const fetchOptions = {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${daemonToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ token, serverId })
        };

        if (isHttps) {
            fetchOptions.agent = new https.Agent({ rejectUnauthorized: true });
        }

        const verifyRes = await fetch(verifyEndpoint, fetchOptions);
        if (!verifyRes.ok) {
            throw new Error(`HTTP ${verifyRes.status}`);
        }
        return await verifyRes.json();
    }

    return new Promise((resolve, reject) => {
        const urlObj = new URL(verifyEndpoint);
        const client = urlObj.protocol === 'https:' ? https : http;
        const postData = JSON.stringify({ token, serverId });

        const req = client.request(urlObj, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${daemonToken}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            rejectUnauthorized: false
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function sanitizeInitialLogs(rawLogs, maxLines = 100, maxBytes = 65536) {
    if (!rawLogs || typeof rawLogs !== 'string') return '';

    let logs = rawLogs;
    if (Buffer.byteLength(logs, 'utf8') > maxBytes) {
        logs = logs.slice(-maxBytes);
        const firstNewline = logs.indexOf('\n');
        if (firstNewline !== -1 && firstNewline < 500) {
            logs = logs.slice(firstNewline + 1);
        }
    }

    const lines = logs.split(/\r?\n/);
    if (lines.length > maxLines) {
        logs = lines.slice(-maxLines).join('\r\n');
    }

    return logs;
}

async function handleContainerExit(serverId, activeSockets, stopIntentMap) {
    const currentState = serverStateMap.get(serverId);
    if (currentState === 'offline') {
        return;
    }

    const intentType = stopIntentMap.get(serverId);
    if (intentType === 'restart') {
        return;
    }

    serverStateMap.set(serverId, 'offline');
    docker.stopLiveLogStream(serverId);

    const containerName = `cyrus_${serverId}`;
    const info = await docker.inspectContainer(containerName).catch(() => null);
    const exitCode = info?.State?.ExitCode ?? 0;
    const isIntentionalStop = stopIntentMap.has(serverId) || currentState === 'stopping';
    stopIntentMap.delete(serverId);

    broadcastToServer(activeSockets, serverId, { 
        event: 'status', 
        args: ['offline'] 
    });

    const isCleanSignal = exitCode === 0 || exitCode === 130 || exitCode === 143 || exitCode === 137;

    if (!isIntentionalStop && !isCleanSignal) {
        broadcastToServer(activeSockets, serverId, {
            event: 'console output',
            args: [
                `\r\n${BADGE_ERROR}\x1b[31m---------- Detected server process in a crashed state! ----------\x1b[0m\r\n` +
                `${BADGE_ERROR}\x1b[31mExit Code: ${exitCode}\x1b[0m\r\n` +
                `${BADGE_STATE}\x1b[36mServer marked as offline...\x1b[0m\r\n`
            ]
        });
    } else {
        broadcastToServer(activeSockets, serverId, {
            event: 'console output',
            args: [`\r\n${BADGE_STATE}\x1b[36mServer marked as offline...\x1b[0m\r\n`]
        });
    }
}

function calculateMetrics(stats, info, serverId) {
    if (!stats || !info?.State?.Running) {
        return {
            cpu_absolute: 0,
            memory_bytes: 0,
            memory_limit_bytes: 0,
            disk_bytes: 0,
            network_rx_bytes: 0,
            network_tx_bytes: 0,
            uptime_seconds: 0
        };
    }

    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
    const onlineCpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

    let cpuPercent = 0.0;
    if (systemDelta > 0.0 && cpuDelta > 0.0) {
        cpuPercent = (cpuDelta / systemDelta) * onlineCpus * 100.0;
    }

    const memoryBytes = stats.memory_stats?.usage || 0;
    const memoryLimitBytes = stats.memory_stats?.limit || 0;
    let rxBytes = 0;
    let txBytes = 0;
    if (stats.networks) {
        for (const net of Object.values(stats.networks)) {
            rxBytes += net.rx_bytes || 0;
            txBytes += net.tx_bytes || 0;
        }
    }

    const volumeDir = `/var/lib/cyruspanel/volumes/${serverId}`;
    const diskBytes = docker.getDirectorySize ? docker.getDirectorySize(volumeDir) : 0;

    let uptimeSeconds = 0;
    if (info?.State?.StartedAt) {
        const startTime = new Date(info.State.StartedAt).getTime();
        if (!isNaN(startTime) && startTime > 0) {
            uptimeSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
        }
    }

    return {
        cpu_absolute: parseFloat(cpuPercent.toFixed(2)),
        memory_bytes: memoryBytes,
        memory_limit_bytes: memoryLimitBytes,
        disk_bytes: diskBytes,
        network_rx_bytes: rxBytes,
        network_tx_bytes: txBytes,
        uptime_seconds: uptimeSeconds
    };
}

module.exports = {
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
};
