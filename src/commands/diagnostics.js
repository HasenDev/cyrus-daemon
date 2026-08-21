const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const logger = require('../lib/logger');
const configManager = require('../lib/config');
function checkDocker(socketPath = '/var/run/docker.sock') {
    return new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        const targetSocket = isWin ? '//./pipe/docker_engine' : socketPath;

        if (!isWin && !fs.existsSync(targetSocket)) {
            return resolve({
                passed: false,
                message: `Docker socket missing at ${targetSocket}. Is Docker installed?`
            });
        }

        const options = {
            socketPath: targetSocket,
            path: '/version',
            method: 'GET',
            timeout: 4000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        resolve({
                            passed: true,
                            version: parsed.Version || 'Unknown',
                            apiVersion: parsed.ApiVersion || 'Unknown'
                        });
                    } catch {
                        resolve({ passed: true, version: 'Active (Unparsed)', apiVersion: 'Unknown' });
                    }
                } else {
                    resolve({ passed: false, message: `Docker daemon returned HTTP ${res.statusCode}` });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ passed: false, message: 'Docker daemon connection timed out (is Docker hung?)' });
        });

        req.on('error', (err) => {
            resolve({ passed: false, message: `Cannot connect to Docker: ${err.message}` });
        });

        req.end();
    });
}
function checkPortAvailable(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    resolve({ available: false, error: 'Port already in use' });
                } else {
                    resolve({ available: false, error: err.message });
                }
            })
            .once('listening', () => {
                tester.once('close', () => resolve({ available: true })).close();
            })
            .listen(port, host);
    });
}

async function diagnosticsCommand() {
    logger.printBanner();
    logger.info('Running system & environment diagnostics checks...\n');
    let passed = true;
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor < 18) {
        logger.warn(`Node.js version is ${process.version}. Recommended version is >= 18.x.`);
    } else {
        logger.success(`Node.js runtime version: ${logger.bold(process.version)}`);
    }
    if (process.platform !== 'win32') {
        if (process.getuid && process.getuid() !== 0) {
            logger.warn('Daemon is not running as root (UID 0). Some container/filesystem operations may fail.');
        } else {
            logger.success('Running with root administrative privileges.');
        }
    }
    let cfg = null;
    try {
        cfg = configManager.load();
        if (!cfg.uuid || !cfg.api?.port) {
            throw new Error('Config file is missing required fields (uuid or api.port).');
        }
        logger.success(`Configuration file valid (${logger.accent(configManager.CONFIG_PATH)})`);
        logger.info(`Node UUID: ${logger.bold(cfg.uuid)} | Configured Port: ${logger.bold(cfg.api.port)}`);
    } catch (err) {
        logger.error(`Configuration Check Failed: ${err.message}`);
        passed = false;
    }
    const socketPath = cfg?.docker?.socket || '/var/run/docker.sock';
    const dockerResult = await checkDocker(socketPath);
    if (dockerResult.passed) {
        logger.success(`Docker is installed & active (Version: ${logger.accent(dockerResult.version)}, API: ${dockerResult.apiVersion})`);
    } else {
        logger.error(`Docker Check Failed: ${dockerResult.message}`);
        passed = false;
    }
    const dataDir = cfg?.storage?.path || cfg?.system?.data_dir || '/var/lib/cyruspanel/volumes';
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            logger.success(`Created missing data directory at ${dataDir}`);
        } else {
            logger.success(`Data storage directory exists (${dataDir})`);
        }
        const testFile = path.join(dataDir, `.cyrus_write_test_${Date.now()}`);
        fs.writeFileSync(testFile, 'write_test');
        fs.unlinkSync(testFile);
        logger.success(`Storage directory permissions: Read/Write OK`);
    } catch (e) {
        logger.error(`Failed to verify storage directory (${dataDir}): ${e.message}`);
        passed = false;
    }
    if (cfg?.api?.port) {
        const port = Number(cfg.api.port);
        const host = cfg.api.host || '0.0.0.0';
        const portResult = await checkPortAvailable(port, host);
        if (portResult.available) {
            logger.success(`Port ${port} on ${host} is open and available.`);
        } else {
            logger.error(`Port conflict on ${host}:${port} (${portResult.error})`);
            passed = false;
        }
    }
    const totalMemGB = (os.totalmem() / (1024 ** 3)).toFixed(2);
    const freeMemGB = (os.freemem() / (1024 ** 3)).toFixed(2);
    logger.info(`System Memory: ${freeMemGB} GB free of ${totalMemGB} GB | CPU Cores: ${os.cpus().length}`);
    console.log('');
    if (passed) {
        logger.success('All diagnostic checks passed successfully! The node is ready.');
    } else {
        logger.error('Diagnostics finished with errors. Please resolve the issues above before starting.');
        process.exitCode = 1;
    }
}

module.exports = diagnosticsCommand;
