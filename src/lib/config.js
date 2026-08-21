const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CONFIG_DIR = '/etc/cyruspanel';
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_DOCKER_NETWORK = {
    name: 'cyrus_nw',
    interface: '172.19.0.1',
    dns: ['1.1.1.1', '1.0.0.1'],
    mode: 'cyrus_nw',
    driver: 'bridge'
};

function ensureDefaults(config) {
    let modified = false;

    if (!config.docker || typeof config.docker !== 'object') {
        config.docker = {};
        modified = true;
    }

    if (!config.docker.network || typeof config.docker.network !== 'object') {
        config.docker.network = { ...DEFAULT_DOCKER_NETWORK };
        modified = true;
    } else {
        if (!config.docker.network.name) {
            config.docker.network.name = DEFAULT_DOCKER_NETWORK.name;
            modified = true;
        }
        if (!config.docker.network.interface) {
            config.docker.network.interface = DEFAULT_DOCKER_NETWORK.interface;
            modified = true;
        }
        if (!Array.isArray(config.docker.network.dns) || config.docker.network.dns.length === 0) {
            config.docker.network.dns = [...DEFAULT_DOCKER_NETWORK.dns];
            modified = true;
        }
        if (!config.docker.network.mode) {
            config.docker.network.mode = config.docker.network.name;
            modified = true;
        }
    }

    return { config, modified };
}

function exists() {
    return fs.existsSync(CONFIG_PATH);
}

function load() {
    if (!exists()) {
        throw new Error(`Configuration file not found at ${CONFIG_PATH}. Run 'cyrus-daemon configure' first.`);
    }

    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        let config = JSON.parse(raw);

        if (!config.uuid || !config.token) {
            throw new Error('Configuration file is missing required fields (uuid, token).');
        }

        const { config: updatedConfig, modified } = ensureDefaults(config);
        if (modified) {
            save(updatedConfig, false);
        }

        return updatedConfig;
    } catch (err) {
        throw new Error(`Failed to parse configuration file (${CONFIG_PATH}): ${err.message}`);
    }
}

function save(configData, logSuccess = true) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o755 });
    }

    const { config: finalConfig } = ensureDefaults(configData);

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(finalConfig, null, 2), { mode: 0o600 });
    if (logSuccess) {
        logger.success(`Configuration written successfully to ${logger.accent(CONFIG_PATH)}`);
    }
}

module.exports = {
    CONFIG_PATH,
    DEFAULT_DOCKER_NETWORK,
    exists,
    load,
    save
};