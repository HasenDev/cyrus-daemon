const fs = require('fs');
const path = require('path');
const resolvePath = require('resolve-path');
const mime = require('mime-types');

const VOLUMES_ROOT = path.resolve('/var/lib/cyruspanel/volumes');

function verifyNoSymlinks(serverRoot, targetPath) {
    const rel = path.relative(serverRoot, targetPath);
    const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
    let current = serverRoot;

    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        throw new Error('Access denied: Symbolic links are not permitted.');
    }

    for (const part of parts) {
        current = path.join(current, part);
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) {
                throw new Error('Access denied: Symbolic links are not permitted.');
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                break;
            }
            throw err;
        }
    }
}

function resolveSafePath(serverId, relativePath = '/') {
    if (!serverId || typeof serverId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
        throw new Error('Access denied: Invalid server identifier.');
    }

    const realVolumesRoot = fs.existsSync(VOLUMES_ROOT) ? fs.realpathSync(VOLUMES_ROOT) : VOLUMES_ROOT;
    const serverRoot = resolvePath(realVolumesRoot, serverId);

    if (!serverRoot.startsWith(realVolumesRoot + path.sep)) {
        throw new Error('Access denied: Invalid containment root.');
    }

    if (!fs.existsSync(serverRoot)) {
        fs.mkdirSync(serverRoot, { recursive: true, mode: 0o755 });
        try { fs.chmodSync(serverRoot, 0o755); } catch (_) {}
    }

    if (fs.lstatSync(serverRoot).isSymbolicLink()) {
        throw new Error('Access denied: Symbolic links are not permitted.');
    }

    const realServerRoot = fs.realpathSync(serverRoot);
    if (realServerRoot !== serverRoot && !realServerRoot.startsWith(realVolumesRoot + path.sep)) {
        throw new Error('Access denied: Server root containment violation.');
    }

    const cleanRelative = path.normalize(String(relativePath || '/'))
        .replace(/^(\.\.(\/|\\|$))+/, '')
        .replace(/^[/\\]+/, '') || '.';

    const targetPath = resolvePath(realServerRoot, cleanRelative);

    if (targetPath !== realServerRoot && !targetPath.startsWith(realServerRoot + path.sep)) {
        throw new Error('Access denied: Path escapes server containment root.');
    }

    verifyNoSymlinks(realServerRoot, targetPath);

    return { 
        serverRoot: realServerRoot, 
        targetPath, 
        cleanRelative: cleanRelative === '.' ? '/' : '/' + cleanRelative 
    };
}

function getFilePermissions(mode) {
    return '0' + (mode & parseInt('777', 8)).toString(8);
}

function getMimeType(fileName) {
    return mime.lookup(fileName) || 'application/octet-stream';
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
