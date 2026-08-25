const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const configManager = require('../lib/config');
const createDaemonServer = require('../server');
const { startSyncCron, stopSyncCron } = require('../lib/syncCron');
const daemonInfo = require('../lib/daemonInformation');

function verifyDockerSocket(socketPath = '/var/run/docker.sock') {
    return new Promise((resolve) => {
        if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
            return resolve({ ok: false, error: `Docker socket not found at ${socketPath}` });
        }

        const options = {
            socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : socketPath,
            path: '/_ping',
            method: 'GET',
            timeout: 3000
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === 200) {
                resolve({ ok: true });
            } else {
                resolve({ ok: false, error: `Docker returned HTTP status ${res.statusCode}` });
            }
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, error: 'Docker daemon connection timed out' });
        });

        req.on('error', (err) => {
            resolve({ ok: false, error: err.message });
        });

        req.end();
    });
}

async function startCommand() {
    logger.printBanner();
    daemonInfo.checkForUpdates().then((update) => {
        if (update && update.hasUpdate) {
            console.log('');
            logger.warn('═════════════════════════════════════════════════════════════════');
            logger.warn(` An update is available: ${logger.bold(`v${update.latestVersion}`)} (Current: v${update.currentVersion})`);
            logger.warn(` Run ${logger.accent('cyrus-daemon update')} to automatically update the daemon.`);
            logger.warn('═════════════════════════════════════════════════════════════════');
            console.log('');
        }
    }).catch(() => {});

    logger.info('Loading daemon configuration...');
    let config;
    try {
        config = configManager.load();
        logger.success('Configuration loaded successfully.');
    } catch (err) {
        logger.error(`Failed to load configuration: ${err.message}`);
        process.exit(1);
    }

    const dataDir = config.storage?.path || config.system?.data_dir || '/var/lib/cyruspanel/volumes';
    try {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            logger.info(`Created storage directory: ${dataDir}`);
        }
        fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
        logger.error(`Storage directory (${dataDir}) is not accessible/writable: ${err.message}`);
        process.exit(1);
    }

    const dockerSocket = config.docker?.socket || '/var/run/docker.sock';
    logger.info('Checking Docker daemon status...');
    const dockerStatus = await verifyDockerSocket(dockerSocket);
    if (!dockerStatus.ok) {
        logger.error(`Docker verification failed: ${dockerStatus.error}`);
        logger.warn('Please ensure Docker is installed and running (`systemctl start docker`).');
        process.exit(1);
    }
    logger.success('Docker daemon is responsive.');

    let server;
    try {
        server = await createDaemonServer(config);
        const port = Number(config.api?.port) || 8080;
        const host = config.api?.host || '0.0.0.0';

        await server.listen({ port, host });
        logger.success(`Cyrus Daemon listening on ${logger.accent(`${host}:${port}`)}`);
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            logger.error(`Port ${config.api?.port || 8080} is already in use by another process.`);
        } else {
            logger.error(`Failed to start daemon HTTP server: ${err.message}`);
        }
        process.exit(1);
    }

    try {
        if (typeof startSyncCron === 'function') {
            startSyncCron(config);
            logger.info('Background sync scheduler started.');
        }
    } catch (err) {
        logger.warn(`Failed to start sync cron: ${err.message}`);
    }

    logger.info('Daemon is active and ready for container operations.');

    let isShuttingDown = false;

    const shutdown = async (signal) => {
        if (isShuttingDown) {
            logger.warn('Forcing immediate shutdown...');
            process.exit(1);
        }
        isShuttingDown = true;

        logger.info(`\nReceived ${signal}. Shutting down gracefully...`);
        const forceExitTimer = setTimeout(() => {
            logger.warn('Graceful shutdown timed out after 3s. Force terminating process.');
            process.exit(0);
        }, 3000);
        forceExitTimer.unref();

        try {
            if (typeof stopSyncCron === 'function') {
                stopSyncCron();
            }

            if (server) {
                if (typeof server.close === 'function') {
                    await Promise.race([
                        server.close(),
                        new Promise((resolve) => setTimeout(resolve, 2000))
                    ]);
                }
            }

            clearTimeout(forceExitTimer);
            logger.success('Daemon stopped cleanly.');
            process.exit(0);
        } catch (err) {
            logger.error(`Error during graceful shutdown: ${err.message}`);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger.error(`Unhandled Promise Rejection: ${reason && reason.stack ? reason.stack : reason}`);
    });
}

module.exports = startCommand;
