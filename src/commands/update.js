const fs = require('fs');
const https = require('https');
const readline = require('readline');
const { execSync } = require('child_process');
const logger = require('../lib/logger');
const daemonInfo = require('../lib/daemonInformation');
const BINARY_DESTINATION = '/usr/local/bin/cyrus-daemon';
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(destPath);

        const makeRequest = (currentUrl) => {
            https.get(currentUrl, { headers: { 'User-Agent': 'Cyrus-Daemon-Updater' } }, (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                    return makeRequest(res.headers.location);
                }

                if (res.statusCode !== 200) {
                    fileStream.close();
                    fs.unlink(destPath, () => {});
                    return reject(new Error(`Download failed with HTTP status ${res.statusCode}`));
                }

                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close(resolve);
                });
            }).on('error', (err) => {
                fileStream.close();
                fs.unlink(destPath, () => {});
                reject(err);
            });
        };

        makeRequest(url);
    });
}
function checkSystemdServiceExists(serviceName = 'cyrus-daemon') {
    if (process.platform !== 'linux') return false;
    try {
        const output = execSync(`systemctl list-unit-files ${serviceName}.service`, {
            stdio: ['pipe', 'pipe', 'ignore'],
            encoding: 'utf8'
        });
        return output.includes(`${serviceName}.service`);
    } catch {
        try {
            execSync(`systemctl status ${serviceName}`, {
                stdio: ['pipe', 'pipe', 'ignore'],
                encoding: 'utf8'
            });
            return true;
        } catch {
            return false;
        }
    }
}
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(query, (ans) => {
            rl.close();
            resolve(ans.trim());
        });
    });
}

async function updateCommand(args = []) {
    logger.printBanner();
    const force = args.includes('--force') || args.includes('-f');

    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
        logger.warn('Updating the binary usually requires root permissions.');
        logger.warn('If write permission fails, please re-run using: `sudo cyrus-daemon update`\n');
    }

    logger.info('Checking for latest release on GitHub...');
    const updateInfo = await daemonInfo.checkForUpdates();

    if (updateInfo.error && !force) {
        logger.error(`Failed to verify latest release: ${updateInfo.error}`);
        process.exit(1);
    }

    logger.info(`Current Version: ${logger.bold(`v${daemonInfo.VERSION}`)}`);
    logger.info(`Latest Version:  ${logger.bold(updateInfo.rawLatestTag || `v${daemonInfo.VERSION}`)}`);

    if (!updateInfo.hasUpdate && !force) {
        logger.success('You are already running the latest version of Cyrus Daemon.');
        return;
    }

    if (updateInfo.hasUpdate) {
        logger.info(`Update available: ${logger.accent(`v${daemonInfo.VERSION}`)} -> ${logger.accent(updateInfo.rawLatestTag)}`);
    } else if (force) {
        logger.warn('Forcing re-installation of latest release binary...');
    }

    const tempBinaryPath = `${BINARY_DESTINATION}.tmp-${Date.now()}`;

    try {
        logger.info(`Downloading update from: ${daemonInfo.DOWNLOAD_URL}`);
        await downloadFile(daemonInfo.DOWNLOAD_URL, tempBinaryPath);
        fs.chmodSync(tempBinaryPath, 0o755);
        fs.renameSync(tempBinaryPath, BINARY_DESTINATION);
        fs.chmodSync(BINARY_DESTINATION, 0o755);

        logger.success(`Successfully updated binary at ${BINARY_DESTINATION}`);
    } catch (err) {
        if (fs.existsSync(tempBinaryPath)) {
            fs.unlinkSync(tempBinaryPath);
        }
        logger.error(`Update failed: ${err.message}`);
        logger.warn('Ensure you have root/sudo privileges to write to /usr/local/bin.');
        process.exit(1);
    }
    const hasService = checkSystemdServiceExists('cyrus-daemon');
    if (hasService) {
        logger.info('Detected systemd service: `cyrus-daemon`');
        const answer = await askQuestion(`${logger.accent('[?]')} Do you want to restart the cyrus-daemon service now? (Y/n): `);

        if (answer.toLowerCase() === '' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            try {
                logger.info('Restarting cyrus-daemon service...');
                execSync('systemctl restart cyrus-daemon', { stdio: 'inherit' });
                logger.success('cyrus-daemon service restarted successfully.');
                logger.info('Zero downtime: Running containers remain unaffected in the background.');
            } catch (err) {
                logger.error(`Failed to restart service: ${err.message}`);
                logger.warn('You can restart manually using: `sudo systemctl restart cyrus-daemon`');
            }
        } else {
            logger.info('Skipping service restart. Remember to restart it later (`sudo systemctl restart cyrus-daemon`).');
        }
    } else {
        logger.info('No active systemd service named `cyrus-daemon` found. Update complete. Please manually restart the daemon if its running.');
    }
}

module.exports = updateCommand;
