const logger = require('../lib/logger');
const configManager = require('../lib/config');

async function configureCommand(args) {
    logger.printBanner();

    let panelUrl = null;
    let token = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--panel-url' && args[i + 1]) {
            panelUrl = args[i + 1];
        }
        if (args[i] === '--token' && args[i + 1]) {
            token = args[i + 1];
        }
    }

    if (!panelUrl || !token) {
        logger.error('Missing required flags.');
        console.log(`\nUsage:\n  cyrus-daemon configure --panel-url ${logger.accent('https://your-panel.com')} --token ${logger.accent('<DEPLOY_TOKEN>')}\n`);
        process.exit(1);
    }

    const cleanPanelUrl = panelUrl.replace(/\/+$/, '');
    const autoconfigUrl = `${cleanPanelUrl}/api/v1/admin/nodes/manage/autoconfig?token=${encodeURIComponent(token)}`;

    logger.info(`Fetching configuration specs from ${logger.accent(cleanPanelUrl)}...`);

    try {
        const res = await fetch(autoconfigUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        const data = await res.json();

        if (!res.ok) {
            logger.error(`Panel configuration request failed: ${data.error || res.statusText}`);
            process.exit(1);
        }

        data.panel_url = cleanPanelUrl;
        if (!data.docker) data.docker = {};
        if (!data.docker.network) {
            data.docker.network = { ...configManager.DEFAULT_DOCKER_NETWORK };
        }

        configManager.save(data);
        logger.success('Auto-configuration complete! You can now start the daemon using:');
        console.log(`\n  ${logger.accent('cyrus-daemon start')}\n`);
    } catch (err) {
        logger.error(`Failed to connect to panel: ${err.message}`);
        process.exit(1);
    }
}

module.exports = configureCommand;