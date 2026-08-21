const logger = require('../lib/logger');
const configManager = require('../lib/config');
const createDaemonServer = require('../server');
const { startSyncCron } = require('../lib/syncCron');

async function startCommand() {
    logger.printBanner();

    logger.info('Loading daemon configuration...');
    let config;
    try {
        config = configManager.load();
        logger.success('Configuration loaded successfully.');
    } catch (err) {
        logger.error(err.message);
        process.exit(1);
    }
    startSyncCron(config);

    try {
        const server = await createDaemonServer(config);
        const port = config.api?.port || 8080;
        const host = config.api?.host || '0.0.0.0';

        await server.listen({ port, host });
        logger.success(`Cyrus Daemon listening on ${logger.accent(`${host}:${port}`)}`);
        logger.info('Daemon is active and ready for container operations.');
    } catch (err) {
        logger.error(`Failed to start daemon HTTP server: ${err.message}`);
        process.exit(1);
    }
}

module.exports = startCommand;