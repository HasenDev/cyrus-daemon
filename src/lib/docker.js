const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const DOCKER_SOCKET = '/var/run/docker.sock';
const activeStreamListeners = new Map();

function cleanDockerStreamChunkWithRemainder(chunk) {
    if (!chunk || chunk.length === 0) return { text: '', remainder: Buffer.alloc(0) };

    const isMultiplexed = chunk.length >= 8 &&
        (chunk[0] === 1 || chunk[0] === 2) &&
        chunk[1] === 0 &&
        chunk[2] === 0 &&
        chunk[3] === 0;

    if (!isMultiplexed) {
        return { text: chunk.toString('utf8'), remainder: Buffer.alloc(0) };
    }

    let offset = 0;
    let output = '';

    while (offset < chunk.length) {
        if (offset + 8 <= chunk.length && (chunk[offset] === 1 || chunk[offset] === 2) && chunk[offset + 1] === 0) {
            const frameSize = chunk.readUInt32BE(offset + 4);
            const frameStart = offset + 8;
            const frameEnd = frameStart + frameSize;

            if (frameEnd <= chunk.length) {
                output += chunk.toString('utf8', frameStart, frameEnd);
                offset = frameEnd;
            } else {
                return { text: output, remainder: chunk.slice(offset) };
            }
        } else {
            output += chunk.toString('utf8', offset);
            break;
        }
    }

    return { text: output, remainder: Buffer.alloc(0) };
}

function cleanDockerStreamChunk(chunk) {
    return cleanDockerStreamChunkWithRemainder(chunk).text;
}

function dockerRequest(apiPath, method = 'GET', body = null, isStream = false, onStreamChunk = null) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(DOCKER_SOCKET)) {
            return reject(new Error(`Docker Unix Socket not found at ${DOCKER_SOCKET}. Ensure Docker Engine is active.`));
        }

        const options = {
            socketPath: DOCKER_SOCKET,
            path: apiPath,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Host': 'localhost'
            }
        };

        const req = http.request(options, (res) => {
            if (isStream) {
                res.on('data', (chunk) => {
                    if (onStreamChunk) onStreamChunk(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve({ success: true });
                    else reject(new Error(`Docker Stream Error [HTTP ${res.statusCode}]`));
                });
                return;
            }

            let data = '';
            res.on('data', chunk => data += chunk.toString('utf8'));
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = data ? JSON.parse(data) : {};
                } catch {
                    parsed = { raw: data };
                }

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(parsed);
                } else {
                    reject(new Error(parsed.message || `Docker API Error [HTTP ${res.statusCode}]`));
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function ensureNetwork(networkName = 'cyrus_nw', gateway = '172.19.0.1') {
    if (!networkName || networkName === 'host' || networkName === 'bridge' || networkName === 'none') {
        return;
    }

    try {
        await dockerRequest(`/networks/${encodeURIComponent(networkName)}`);
        return;
    } catch (_) {}

    const parts = (gateway || '172.19.0.1').split('.');
    const subnet = parts.length === 4 ? `${parts[0]}.${parts[1]}.0.0/16` : '172.19.0.0/16';

    const networkPayload = {
        Name: networkName,
        Driver: 'bridge',
        EnableIPv6: false,
        Attachable: true,
        Internal: false,
        IPAM: {
            Driver: 'default',
            Config: [
                {
                    Subnet: subnet,
                    Gateway: gateway || '172.19.0.1'
                }
            ]
        },
        Options: {
            'com.docker.network.bridge.name': networkName.slice(0, 15),
            'com.docker.network.bridge.enable_icc': 'true',
            'com.docker.network.bridge.enable_ip_masquerade': 'true'
        }
    };

    try {
        await dockerRequest('/networks/create', 'POST', networkPayload);
    } catch (err) {
        if (!err.message?.includes('already exists')) {
            console.error(`[Docker Network Warning]: ${err.message}`);
        }
    }
}

function getDirectorySize(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return 0;
        const out = execFileSync('du', ['-sk', dirPath], { encoding: 'utf8', stdio: 'pipe' });
        const sizeKB = parseInt(out.split('\t')[0], 10);
        return isNaN(sizeKB) ? 0 : sizeKB * 1024;
    } catch (_) {
        let size = 0;
        try {
            const files = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const file of files) {
                const fullPath = path.join(dirPath, file.name);
                if (file.isDirectory()) {
                    size += getDirectorySize(fullPath);
                } else if (file.isFile()) {
                    size += fs.statSync(fullPath).size;
                }
            }
        } catch {}
        return size;
    }
}

function getDirectorySizeAsync(dirPath) {
    return new Promise((resolve) => {
        if (!fs.existsSync(dirPath)) return resolve(0);
        execFile('du', ['-sk', dirPath], { encoding: 'utf8' }, (err, stdout) => {
            if (err || !stdout) {
                return resolve(getDirectorySize(dirPath));
            }
            const sizeKB = parseInt(stdout.split('\t')[0], 10);
            resolve(isNaN(sizeKB) ? 0 : sizeKB * 1024);
        });
    });
}

function getContainerLogs(id, tail = 100) {
    return new Promise((resolve) => {
        if (!fs.existsSync(DOCKER_SOCKET)) return resolve('');
        const options = {
            socketPath: DOCKER_SOCKET,
            path: `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`,
            method: 'GET',
            headers: { 'Host': 'localhost' }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => {
                data += cleanDockerStreamChunk(chunk);
            });
            res.on('end', () => resolve(data));
        });
        req.on('error', () => resolve(''));
        req.end();
    });
}

function startLiveLogStream(serverId, onData, onEnd) {
    const cleanId = String(serverId).replace(/^cyrus_/, '');
    if (activeStreamListeners.has(cleanId)) {
        stopLiveLogStream(cleanId);
    }

    const containerName = `cyrus_${cleanId}`;
    const streamContext = {
        closedByDaemon: false,
        ended: false,
        socket: null,
        req: null
    };

    activeStreamListeners.set(cleanId, streamContext);

    const options = {
        socketPath: DOCKER_SOCKET,
        path: `/containers/${encodeURIComponent(containerName)}/attach?logs=0&stream=1&stdin=1&stdout=1&stderr=1`,
        method: 'POST',
        headers: {
            'Host': 'localhost',
            'Connection': 'Upgrade',
            'Upgrade': 'tcp'
        }
    };

    let bufferRemainder = Buffer.alloc(0);

    function handleIncoming(chunk) {
        if (!chunk || chunk.length === 0) return;
        const combined = bufferRemainder.length > 0 ? Buffer.concat([bufferRemainder, chunk]) : chunk;
        const { text, remainder } = cleanDockerStreamChunkWithRemainder(combined);
        bufferRemainder = remainder;
        if (text && onData) onData(text);
    }

    function handleEnd() {
        if (streamContext.ended) return;
        streamContext.ended = true;
        activeStreamListeners.delete(cleanId);
        if (!streamContext.closedByDaemon && onEnd) {
            onEnd();
        }
    }

    const req = http.request(options);

    req.on('upgrade', (res, socket, head) => {
        streamContext.socket = socket;
        if (head && head.length > 0) handleIncoming(head);

        socket.on('data', handleIncoming);
        socket.on('end', handleEnd);
        socket.on('error', handleEnd);
        socket.on('close', handleEnd);
    });

    req.on('response', (res) => {
        streamContext.socket = res.socket || req.socket;
        res.on('data', handleIncoming);
        res.on('end', handleEnd);
        res.on('error', handleEnd);
        res.on('close', handleEnd);
    });

    req.on('error', (err) => {
        handleEnd();
    });

    streamContext.req = req;
    req.flushHeaders();
}

function stopLiveLogStream(serverId) {
    const cleanId = String(serverId).replace(/^cyrus_/, '');
    const streamContext = activeStreamListeners.get(cleanId);
    if (streamContext) {
        streamContext.closedByDaemon = true;
        try {
            if (streamContext.socket && !streamContext.socket.destroyed) {
                streamContext.socket.destroy();
            }
        } catch (_) {}
        try {
            if (streamContext.req && !streamContext.req.destroyed) {
                streamContext.req.destroy();
            }
        } catch (_) {}
        activeStreamListeners.delete(cleanId);
    }
}

function isStreamAttached(serverId) {
    const cleanId = String(serverId).replace(/^cyrus_/, '');
    const streamContext = activeStreamListeners.get(cleanId);
    if (!streamContext) return false;
    const sock = streamContext.socket || streamContext.req?.socket;
    return Boolean(sock && !sock.destroyed && sock.writable);
}

function writeContainerStdin(serverIdOrName, data) {
    return new Promise((resolve) => {
        const cleanId = String(serverIdOrName).replace(/^cyrus_/, '');
        const streamContext = activeStreamListeners.get(cleanId);
        const formattedData = data.endsWith('\n') ? data : data + '\n';

        if (streamContext) {
            const sock = streamContext.socket || streamContext.req?.socket;
            if (sock && !sock.destroyed && sock.writable) {
                sock.write(formattedData, 'utf8', (err) => {
                    resolve(!err);
                });
                return;
            }
        }

        const containerName = `cyrus_${cleanId}`;
        if (!fs.existsSync(DOCKER_SOCKET)) return resolve(false);

        const options = {
            socketPath: DOCKER_SOCKET,
            path: `/containers/${encodeURIComponent(containerName)}/attach?stream=1&stdin=1`,
            method: 'POST',
            headers: {
                'Host': 'localhost',
                'Connection': 'Upgrade',
                'Upgrade': 'tcp'
            }
        };

        const req = http.request(options);
        req.on('upgrade', (res, socket) => {
            socket.write(formattedData, 'utf8', () => {
                setTimeout(() => {
                    try { socket.end(); } catch (_) {}
                }, 100);
                resolve(true);
            });
        });

        req.on('response', (res) => {
            const sock = res.socket || req.socket;
            if (sock && sock.writable) {
                sock.write(formattedData, 'utf8', () => resolve(true));
            } else {
                resolve(false);
            }
        });

        req.on('error', () => resolve(false));
        req.flushHeaders();
    });
}

function pullImageWithProgress(imageName, onProgress) {
    const apiPath = `/images/create?fromImage=${encodeURIComponent(imageName)}`;
    return dockerRequest(apiPath, 'POST', null, true, (chunk) => {
        if (!onProgress) return;
        const text = chunk.toString('utf8');
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.status) {
                    const progress = parsed.progress ? ` ${parsed.progress}` : '';
                    onProgress(`${parsed.status}${progress}`);
                }
            } catch (_) {}
        }
    });
}

function execStartWithOutput(execId, onOutput) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(DOCKER_SOCKET)) return reject(new Error('Docker Socket not found'));
        const options = {
            socketPath: DOCKER_SOCKET,
            path: `/exec/${encodeURIComponent(execId)}/start`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Host': 'localhost'
            }
        };

        const req = http.request(options, (res) => {
            res.on('data', chunk => {
                const text = cleanDockerStreamChunk(chunk);
                if (onOutput && text) onOutput(text);
            });
            res.on('end', () => resolve({ success: true }));
        });

        req.on('error', reject);
        req.write(JSON.stringify({ Detach: false, Tty: true }));
        req.end();
    });
}

module.exports = {
    ping: () => dockerRequest('/_ping'),
    pullImage: (imageName) => dockerRequest(`/images/create?fromImage=${encodeURIComponent(imageName)}`, 'POST', null, true),
    pullImageWithProgress,
    ensureNetwork,
    createContainer: (name, config) => {
        if (!config.HostConfig) config.HostConfig = {};

        config.HostConfig.PidsLimit = config.HostConfig.PidsLimit || 512;
        config.HostConfig.OomKillDisable = false;

        if (!config.HostConfig.Ulimits) {
            config.HostConfig.Ulimits = [];
        }

        const hasNoFile = config.HostConfig.Ulimits.some(u => u.Name === 'nofile');
        if (!hasNoFile) config.HostConfig.Ulimits.push({ Name: 'nofile', Soft: 10240, Hard: 10240 });

        const hasNproc = config.HostConfig.Ulimits.some(u => u.Name === 'nproc');
        if (!hasNproc) config.HostConfig.Ulimits.push({ Name: 'nproc', Soft: 512, Hard: 512 });

        return dockerRequest(`/containers/create?name=${encodeURIComponent(name)}`, 'POST', config);
    },
    startContainer: (id) => dockerRequest(`/containers/${encodeURIComponent(id)}/start`, 'POST'),
    stopContainer: (id, timeout = 10) => dockerRequest(`/containers/${encodeURIComponent(id)}/stop?t=${timeout}`, 'POST'),
    killContainer: (id) => dockerRequest(`/containers/${encodeURIComponent(id)}/kill`, 'POST'),
    restartContainer: (id, timeout = 5) => dockerRequest(`/containers/${encodeURIComponent(id)}/restart?t=${timeout}`, 'POST'),
    inspectContainer: (id) => dockerRequest(`/containers/${encodeURIComponent(id)}/json`),
    getContainerStats: (id) => dockerRequest(`/containers/${encodeURIComponent(id)}/stats?stream=false`),
    removeContainer: (id, force = false) => dockerRequest(`/containers/${encodeURIComponent(id)}?v=true&force=${force}`, 'DELETE'),
    execCreate: (id, cmdArray) => dockerRequest(`/containers/${encodeURIComponent(id)}/exec`, 'POST', {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: cmdArray
    }),
    execStartWithOutput,
    writeContainerStdin,
    getDirectorySize,
    getDirectorySizeAsync,
    getContainerLogs,
    startLiveLogStream,
    stopLiveLogStream,
    isStreamAttached
};