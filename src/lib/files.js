const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VOLUMES_ROOT = '/var/lib/cyruspanel/volumes';

function resolveSafePath(serverId, relativePath = '/') {
    const serverRoot = path.resolve(VOLUMES_ROOT, serverId);
    
    if (!fs.existsSync(serverRoot)) {
        fs.mkdirSync(serverRoot, { recursive: true, mode: 0o777 });
        try { fs.chmodSync(serverRoot, 0o777); } catch (_) {}
    }

    const cleanRelative = path.normalize(relativePath || '/').replace(/^(\.\.(\/|\\|$))+/, '');
    const targetPath = path.resolve(serverRoot, '.' + path.sep + cleanRelative);

    if (!targetPath.startsWith(serverRoot)) {
        throw new Error('Access denied: Path escapes server containment root.');
    }

    return { serverRoot, targetPath, cleanRelative };
}

function getFilePermissions(mode) {
    return '0' + (mode & parseInt('777', 8)).toString(8);
}

function getMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const map = {
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.js': 'application/javascript',
        '.ts': 'application/typescript',
        '.py': 'text/x-python',
        '.html': 'text/html',
        '.css': 'text/css',
        '.yml': 'text/yaml',
        '.yaml': 'text/yaml',
        '.properties': 'text/plain',
        '.toml': 'text/plain',
        '.env': 'text/plain',
        '.sh': 'application/x-sh',
        '.zip': 'application/zip',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        '.tgz': 'application/gzip',
        '.jar': 'application/java-archive',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml'
    };
    return map[ext] || 'application/octet-stream';
}

function isArchiveFile(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    return ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.rar'].includes(ext) || fileName.endsWith('.tar.gz');
}

module.exports = {
    VOLUMES_ROOT,
    resolveSafePath,
    getFilePermissions,
    getMimeType,
    isArchiveFile
};