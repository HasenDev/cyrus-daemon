const https = require('https');

const VERSION = '1.0.5';
const REPO = 'HasenDev/cyrus-daemon';
const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_URL = `https://github.com/${REPO}/releases/latest/download/cyrus-daemon`;

function compareVersions(a, b) {
    const normalize = (version) =>
        String(version || '')
            .replace(/^v/i, '')
            .split('.')
            .map((num) => parseInt(num, 10) || 0);

    const [aMajor = 0, aMinor = 0, aPatch = 0] = normalize(a);
    const [bMajor = 0, bMinor = 0, bPatch = 0] = normalize(b);

    if (aMajor !== bMajor) return aMajor - bMajor;
    if (aMinor !== bMinor) return aMinor - bMinor;
    return aPatch - bPatch;
}
async function checkForUpdates() {
    try {
        const data = await new Promise((resolve, reject) => {
            const options = {
                headers: {
                    'User-Agent': 'Cyrus-Daemon-UpdateChecker',
                    'Accept': 'application/vnd.github.v3+json'
                },
                timeout: 5000
            };

            const req = https.get(GITHUB_API_URL, options, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`GitHub API returned status ${res.statusCode}`));
                }

                let rawData = '';
                res.on('data', (chunk) => { rawData += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(rawData));
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Update check timed out'));
            });

            req.on('error', (err) => reject(err));
        });

        const latestTag = data.tag_name || '';
        const hasUpdate = compareVersions(latestTag, VERSION) > 0;

        return {
            hasUpdate,
            currentVersion: VERSION,
            latestVersion: latestTag.replace(/^v/i, ''),
            rawLatestTag: latestTag,
            releaseUrl: data.html_url,
            releaseName: data.name || latestTag,
            body: data.body || ''
        };
    } catch (err) {
        return {
            hasUpdate: false,
            currentVersion: VERSION,
            error: err.message
        };
    }
}

module.exports = {
    VERSION,
    REPO,
    GITHUB_API_URL,
    DOWNLOAD_URL,
    compareVersions,
    checkForUpdates
};
