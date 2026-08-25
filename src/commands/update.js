const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');
const { execSync } = require('child_process');
const { URL } = require('url');
const logger = require('../lib/logger');
const daemonInfo = require('../lib/daemonInformation');

const BINARY_DESTINATION = '/usr/local/bin/cyrus-daemon';
const MAX_REDIRECTS = 5;

function isAllowedUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== 'https:') {
            return false;
        }
        const hostname = parsed.hostname.toLowerCase();
        return (
            hostname === 'github.com' ||
            hostname.endsWith('.github.com') ||
            hostname === 'githubusercontent.com' ||
            hostname.endsWith('.githubusercontent.com')
        );
    } catch {
        return false;
    }
}

function downloadFile(url, destPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (!isAllowedUrl(url)) {
            return reject(new Error(`Untrusted or insecure download URL: ${url}`));
        }

        if (redirectCount > MAX_REDIRECTS) {
            return reject(new Error('Too many redirects while downloading update.'));
        }

        const fileStream = fs.createWriteStream(destPath);

        const req = https.get(url, { headers: { 'User-Agent': 'Cyrus-Daemon-Updater' } }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                fileStream.close();
                fs.unlink(destPath, () => {});

                let redirectUrl;
                try {
                    redirectUrl = new URL(res.headers.location, url).toString();
                } catch {
                    return reject(new Error(`Invalid redirect location header: ${res.headers.location}`));
                }

                if (!isAllowedUrl(redirectUrl)) {
                    return reject(new Error(`Redirect to untrusted or insecure host blocked: ${redirectUrl}`));
                }

                return downloadFile(redirectUrl, destPath, redirectCount + 1).then(resolve).catch(reject);
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
        });

        req.on('error', (err) => {
            fileStream.close();
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

function downloadString(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (!isAllowedUrl(url)) {
            return reject(new Error(`Untrusted or insecure URL: ${url}`));
        }

        if (redirectCount > MAX_REDIRECTS) {
            return reject(new Error('Too many redirects while fetching data.'));
        }

        let data = '';
        const req = https.get(url, { headers: { 'User-Agent': 'Cyrus-Daemon-Updater' } }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                let redirectUrl;
                try {
                    redirectUrl = new URL(res.headers.location, url).toString();
                } catch {
                    return reject(new Error(`Invalid redirect location header: ${res.headers.location}`));
                }

                if (!isAllowedUrl(redirectUrl)) {
                    return reject(new Error(`Redirect to untrusted or insecure host blocked: ${redirectUrl}`));
                }

                return downloadString(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`Request failed with HTTP status ${res.statusCode}`));
            }

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                resolve(data);
            });
        });

        req.on('error', reject);
    });
}

function calculateFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
        stream.on('error', reject);
    });
}

function parseExpectedChecksum(checksumText, targetFileName = 'cyrus-daemon') {
    if (!checksumText) return null;
    const lines = checksumText.trim().split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length === 1 && /^[a-fA-F0-9]{64}$/.test(parts[0])) {
            return parts[0].toLowerCase();
        }
        if (parts.length >= 2) {
            const hashCandidate = parts[0];
            const fileCandidate = parts.slice(1).join(' ').replace(/^\*/, '').trim();
            if (/^[a-fA-F0-9]{64}$/.test(hashCandidate)) {
                if (!targetFileName || fileCandidate.endsWith(targetFileName) || fileCandidate === targetFileName) {
                    return hashCandidate.toLowerCase();
                }
            }
        }
    }
    const match = checksumText.match(/[a-fA-F0-9]{64}/);
    return match ? match[0].toLowerCase() : null;
}

function verifyChecksum(actualHash, expectedHash) {
    if (!actualHash || !expectedHash) return false;
    if (actualHash.length !== 64 || expectedHash.length !== 64) return false;
    return crypto.timingSafeEqual(
        Buffer.from(actualHash.toLowerCase(), 'utf8'),
        Buffer.from(expectedHash.toLowerCase(), 'utf8')
    );
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
            if (typeof process.stdin.pause === 'function') {
                process.stdin.pause();
            }
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
        process.exit(0);
    }

    if (updateInfo.hasUpdate) {
        logger.info(`Update available: ${logger.accent(`v${daemonInfo.VERSION}`)} -> ${logger.accent(updateInfo.rawLatestTag)}`);
    } else if (force) {
        logger.warn('Forcing re-installation of latest release binary...');
    }

    const tempBinaryPath = `${BINARY_DESTINATION}.tmp-${Date.now()}`;
    const checksumUrl = daemonInfo.CHECKSUM_URL || `${daemonInfo.DOWNLOAD_URL}.sha256`;

    try {
        logger.info(`Downloading update from: ${daemonInfo.DOWNLOAD_URL}`);
        await downloadFile(daemonInfo.DOWNLOAD_URL, tempBinaryPath);

        logger.info(`Fetching SHA256 checksum from: ${checksumUrl}`);
        let expectedChecksum = updateInfo.sha256 || updateInfo.checksum || null;

        if (!expectedChecksum) {
            try {
                const checksumData = await downloadString(checksumUrl);
                expectedChecksum = parseExpectedChecksum(checksumData, 'cyrus-daemon');
            } catch (checksumErr) {
                logger.warn(`Failed to retrieve cyrus-daemon.sha256 directly (${checksumErr.message}). Checking alternate locations...`);
                const fallbackUrls = [
                    updateInfo.checksumUrl,
                    `${daemonInfo.DOWNLOAD_URL}.sha256sum`,
                    daemonInfo.DOWNLOAD_URL.substring(0, daemonInfo.DOWNLOAD_URL.lastIndexOf('/') + 1) + 'checksums.txt'
                ].filter(Boolean);

                for (const fbUrl of fallbackUrls) {
                    try {
                        const fbData = await downloadString(fbUrl);
                        const parsed = parseExpectedChecksum(fbData, 'cyrus-daemon');
                        if (parsed) {
                            expectedChecksum = parsed;
                            break;
                        }
                    } catch (_) {}
                }
            }
        }

        logger.info('Verifying binary SHA256 integrity...');
        const actualChecksum = await calculateFileSha256(tempBinaryPath);

        if (expectedChecksum) {
            const isValid = verifyChecksum(actualChecksum, expectedChecksum);
            if (!isValid) {
                throw new Error(`Checksum verification failed!\nExpected SHA256: ${expectedChecksum}\nActual SHA256:   ${actualChecksum}`);
            }
            logger.success(`SHA256 checksum verified: ${actualChecksum}`);
        } else {
            if (!force) {
                throw new Error('Missing `cyrus-daemon.sha256` release asset. Integrity cannot be verified. Use --force to bypass.');
            }
            logger.warn(`No SHA256 checksum found to verify. Proceeding due to --force flag. (SHA256: ${actualChecksum})`);
        }

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

    process.exit(0);
}

module.exports = updateCommand;
