const fs = require('fs');
const logger = require('../lib/logger');
const configManager = require('../lib/config');

async function diagnosticsCommand() {
    logger.printBanner();
    logger.info('Running system & environment diagnostics checks...\n');

    let passed = true;
    if (process.getuid && process.getuid() !== 0) {
        logger.warn('Daemon is not running as root. Some container operations may fail.');
    } else {
        logger.success('Running with root administrative privileges.');
    }
    try {
        const cfg = configManager.load();
        logger.success(`Configuration file valid (${logger.accent(configManager.CONFIG_PATH)})`);
        logger.info(`Node UUID: ${logger.bold(cfg.uuid)} | Port: ${logger.bold(cfg.api.port)}`);
    } catch (err) {
        logger.error(`Configuration Check Failed: ${err.message}`);
        passed = false;
    }
    const dataDir = '/var/lib/cyruspanel/volumes';
    if (!fs.existsSync(dataDir)) {
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            logger.success(`Created data directory at ${dataDir}`);
        } catch (e) {
            logger.error(`Failed to create data directory ${dataDir}: ${e.message}`);
            passed = false;
        }
    } else {
        logger.success(`Data storage directory exists (${dataDir})`);
    }

    console.log('');
    if (passed) {
        logger.success('All diagnostic checks passed successfully!');
    } else {
        logger.error('Diagnostics finished with errors. Please resolve issues before starting.');
    }
}

module.exports = diagnosticsCommand;