const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { resolveSafePath, getFilePermissions, getMimeType, isArchiveFile } = require('../../../../../lib/files');

function sanitizeError(err) {
    if (!err || !err.message) return 'An unexpected file error occurred.';
    return err.message
        .replace(/(?:\/[a-zA-Z0-9_.-]+)+/g, 'target')
        .replace(/target(?:\s+target)+/g, 'target');
}

function getDirUsage(dir) {
    try {
        const out = execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: 'pipe' });
        return (parseInt(out.split('\t')[0], 10) || 0) * 1024;
    } catch {
        return 0;
    }
}

function inspectZipArchive(file) {
    let out = '';
    try {
        out = execFileSync('unzip', ['-Z', file], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
    } catch {
        out = execFileSync('unzip', ['-l', file], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
    }

    const lines = out.split('\n');
    let totalSize = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('Archive:') || line.startsWith('Zip file size:')) continue;

        if (line.includes('files,') && line.includes('uncompressed')) {
            const match = line.match(/(\d+)\s+bytes uncompressed/);
            if (match && match[1]) {
                const parsed = parseInt(match[1], 10);
                if (parsed > 0) totalSize = parsed;
            }
            continue;
        }

        const parts = line.split(/\s+/);
        if (parts.length >= 8 && /^[ld\-?cbps][rwx\-stST]{9}/.test(parts[0])) {
            const isSymlink = parts[0].startsWith('l');
            const sizeStr = parts[3];
            if (/^\d+$/.test(sizeStr)) {
                totalSize += parseInt(sizeStr, 10);
            }

            let entryPath = '';
            let linkTarget = null;

            const remainingText = parts.slice(7).join(' ');
            if (remainingText.includes(' -> ')) {
                const split = remainingText.split(' -> ');
                entryPath = split[0].trim();
                linkTarget = split[1]?.trim();
            } else {
                entryPath = remainingText;
            }

            if (entryPath) {
                const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'));
                if (normalized.startsWith('..') || normalized.startsWith('/') || path.isAbsolute(normalized)) {
                    throw new Error(`Unsafe entry path in archive: ${entryPath}`);
                }
            }

            if (isSymlink && linkTarget) {
                const normalizedTarget = path.posix.normalize(linkTarget.replace(/\\/g, '/'));
                if (normalizedTarget.startsWith('..') || normalizedTarget.startsWith('/') || path.isAbsolute(normalizedTarget)) {
                    throw new Error(`Unsafe symlink target in archive: ${linkTarget}`);
                }
            }
        } else if (parts.length >= 4 && /^\d+$/.test(parts[0])) {
            const sizeStr = parts[0];
            totalSize += parseInt(sizeStr, 10);
            const entryPath = parts.slice(3).join(' ');
            if (entryPath) {
                const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'));
                if (normalized.startsWith('..') || normalized.startsWith('/') || path.isAbsolute(normalized)) {
                    throw new Error(`Unsafe entry path in archive: ${entryPath}`);
                }
            }
        }
    }

    return totalSize;
}

function inspectTarArchive(file) {
    const out = execFileSync('tar', ['-tvf', file], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
    let totalSize = 0;
    const lines = out.split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;

        let sizeIndex = -1;
        for (let i = 1; i < Math.min(parts.length, 5); i++) {
            if (/^\d+$/.test(parts[i])) {
                sizeIndex = i;
                break;
            }
        }

        if (sizeIndex !== -1) {
            totalSize += parseInt(parts[sizeIndex], 10) || 0;
        }

        const dateIdx = sizeIndex !== -1 ? sizeIndex + 3 : 5;
        let entryPath = '';
        let linkTarget = null;

        if (line.includes(' -> ')) {
            const split = line.split(' -> ');
            linkTarget = split[1]?.trim();
            const leftParts = split[0].trim().split(/\s+/);
            entryPath = leftParts.slice(dateIdx).join(' ');
        } else if (line.includes(' link to ')) {
            const split = line.split(' link to ');
            linkTarget = split[1]?.trim();
            const leftParts = split[0].trim().split(/\s+/);
            entryPath = leftParts.slice(dateIdx).join(' ');
        } else {
            entryPath = parts.slice(dateIdx).join(' ');
        }

        if (entryPath) {
            const normalized = path.posix.normalize(entryPath.replace(/\\/g, '/'));
            if (normalized.startsWith('..') || normalized.startsWith('/') || path.isAbsolute(normalized)) {
                throw new Error(`Unsafe entry path in archive: ${entryPath}`);
            }
        }

        if (linkTarget) {
            const normalizedTarget = path.posix.normalize(linkTarget.replace(/\\/g, '/'));
            if (normalizedTarget.startsWith('..') || normalizedTarget.startsWith('/') || path.isAbsolute(normalizedTarget)) {
                throw new Error(`Unsafe symlink target in archive: ${linkTarget}`);
            }
        }
    }

    return totalSize;
}

function sanitizeExtractedSymlinks(scanDir, baseBoundaryDir) {
    const resolvedBoundary = path.resolve(baseBoundaryDir || scanDir);

    function walk(currentDir) {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            try {
                const lstat = fs.lstatSync(fullPath);

                if (lstat.isSymbolicLink()) {
                    let linkTarget;
                    try {
                        linkTarget = fs.readlinkSync(fullPath);
                    } catch {
                        fs.unlinkSync(fullPath);
                        continue;
                    }

                    const resolvedTarget = path.resolve(currentDir, linkTarget);

                    if (!resolvedTarget.startsWith(resolvedBoundary + path.sep) && resolvedTarget !== resolvedBoundary) {
                        fs.unlinkSync(fullPath);
                    }
                } else if (lstat.isDirectory()) {
                    walk(fullPath);
                }
            } catch (_) {}
        }
    }

    walk(path.resolve(scanDir));
}

module.exports = {
    GET: async (req, reply) => {
        const serverId = req.params.id;
        const action = req.query.action || 'list';

        try {
            if (action === 'usage') {
                const { targetPath } = resolveSafePath(serverId, '/');
                const usageBytes = fs.existsSync(targetPath) ? getDirUsage(targetPath) : 0;
                return reply.status(200).send({ usageBytes });
            }

            if (action === 'content') {
                const filePath = req.query.file;
                if (!filePath) return reply.status(400).send({ error: 'File path is required.' });

                const { targetPath } = resolveSafePath(serverId, filePath);
                if (!fs.existsSync(targetPath)) return reply.status(404).send({ error: 'File not found.' });

                let fd;
                let stat;
                let content;

                try {
                    fd = fs.openSync(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                    stat = fs.fstatSync(fd);

                    if (stat.isDirectory()) {
                        fs.closeSync(fd);
                        return reply.status(400).send({ error: 'Target is a directory, not a file.' });
                    }

                    if (stat.size > 5 * 1024 * 1024) {
                        fs.closeSync(fd);
                        return reply.status(400).send({ error: 'File exceeds editable size limit (5 MB).' });
                    }

                    const buffer = Buffer.alloc(stat.size);
                    fs.readSync(fd, buffer, 0, stat.size, 0);
                    fs.closeSync(fd);
                    content = buffer.toString('utf8');
                } catch (err) {
                    if (fd !== undefined) {
                        try { fs.closeSync(fd); } catch (_) {}
                    }
                    if (err.code === 'ELOOP' || err.code === 'SYMLINK_LOOP') {
                        return reply.status(400).send({ error: 'Access denied: Symbolic links are not permitted.' });
                    }
                    throw err;
                }

                return reply.status(200).send({ content, size: stat.size, name: path.basename(targetPath) });
            }

            const dirParam = req.query.directory || '/';
            const { targetPath, cleanRelative } = resolveSafePath(serverId, dirParam);

            if (!fs.existsSync(targetPath)) {
                return reply.status(404).send({ error: 'Directory does not exist.' });
            }

            const entries = fs.readdirSync(targetPath, { withFileTypes: true });
            const files = [];

            for (const entry of entries) {
                const entryFullPath = path.join(targetPath, entry.name);
                try {
                    const stats = fs.statSync(entryFullPath);
                    const isDir = entry.isDirectory();
                    const isSymlink = entry.isSymbolicLink();

                    files.push({
                        name: entry.name,
                        size: isDir ? 0 : stats.size,
                        directory: isDir,
                        symlink: isSymlink,
                        isArchive: isArchiveFile(entry.name),
                        mimeType: isDir ? 'inode/directory' : getMimeType(entry.name),
                        permissions: getFilePermissions(stats.mode),
                        rawMode: (stats.mode & 0o777).toString(8),
                        modifiedAt: stats.mtime.toISOString(),
                        createdAt: stats.birthtime.toISOString()
                    });
                } catch {}
            }

            files.sort((a, b) => {
                if (a.directory === b.directory) return a.name.localeCompare(b.name);
                return a.directory ? -1 : 1;
            });

            return reply.status(200).send({ files, currentDirectory: cleanRelative });
        } catch (err) {
            return reply.status(400).send({ error: sanitizeError(err) });
        }
    },

    POST: async (req, reply) => {
        const serverId = req.params.id;
        const { action, diskLimitMB } = req.body || {};
        if (!action) return reply.status(400).send({ error: 'Action parameter is required.' });

        const maxBytes = (diskLimitMB || 0) * 1024 * 1024;
        const { targetPath: rootPath } = resolveSafePath(serverId, '/');
        const currentUsageBytes = maxBytes > 0 && fs.existsSync(rootPath) ? getDirUsage(rootPath) : 0;

        const checkSpace = (addedBytes = 0) => {
            if (maxBytes > 0 && (currentUsageBytes + addedBytes) > maxBytes) {
                throw new Error('Server storage limit reached or exceeded.');
            }
        };

        try {
            if (action === 'write') {
                const { file, content } = req.body;
                if (!file) return reply.status(400).send({ error: 'File path required.' });
                const { targetPath } = resolveSafePath(serverId, file);

                let existingSize = 0;
                if (fs.existsSync(targetPath)) {
                    try {
                        const lstat = fs.lstatSync(targetPath);
                        if (lstat.isSymbolicLink()) {
                            return reply.status(400).send({ error: 'Access denied: Symbolic links are not permitted.' });
                        }
                        existingSize = lstat.size;
                    } catch (_) {}
                }

                const newSize = Buffer.byteLength(content || '', 'utf8');
                checkSpace(newSize - existingSize);

                const parentDir = path.dirname(targetPath);
                if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true, mode: 0o777 });

                let fd;
                try {
                    fd = fs.openSync(targetPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o666);
                    const buffer = Buffer.from(content || '', 'utf8');
                    fs.writeSync(fd, buffer, 0, buffer.length, 0);
                    fs.closeSync(fd);
                } catch (err) {
                    if (fd !== undefined) {
                        try { fs.closeSync(fd); } catch (_) {}
                    }
                    if (err.code === 'ELOOP' || err.code === 'SYMLINK_LOOP') {
                        return reply.status(400).send({ error: 'Access denied: Symbolic links are not permitted.' });
                    }
                    throw err;
                }

                return reply.status(200).send({ success: true, message: 'File saved successfully.' });
            }

            if (action === 'create-folder') {
                const { name, directory } = req.body;
                if (!name) return reply.status(400).send({ error: 'Folder name is required.' });
                const { targetPath } = resolveSafePath(serverId, path.join(directory || '/', name));

                checkSpace(4096);

                if (fs.existsSync(targetPath)) return reply.status(400).send({ error: 'Folder or file already exists.' });
                fs.mkdirSync(targetPath, { recursive: true, mode: 0o777 });

                return reply.status(200).send({ success: true, message: 'Folder created.' });
            }

            if (action === 'delete') {
                const { files, root = '/' } = req.body;
                if (!Array.isArray(files) || files.length === 0) {
                    return reply.status(400).send({ error: 'Files array is required for deletion.' });
                }

                for (const fileName of files) {
                    if (typeof fileName !== 'string' || !fileName) continue;
                    const { targetPath } = resolveSafePath(serverId, path.join(root, fileName));
                    if (fs.existsSync(targetPath)) {
                        fs.rmSync(targetPath, { recursive: true, force: true });
                    }
                }
                return reply.status(200).send({ success: true, message: 'Items deleted.' });
            }

            if (action === 'rename' || action === 'move') {
                const { from, to, root = '/' } = req.body;
                if (!from || !to) return reply.status(400).send({ error: 'From and to paths are required.' });

                const { targetPath: sourcePath } = resolveSafePath(serverId, path.join(root, from));
                let { targetPath: destPath } = resolveSafePath(serverId, path.join(root, to));

                if (!fs.existsSync(sourcePath)) return reply.status(404).send({ error: 'Source file/folder does not exist.' });

                if (fs.existsSync(destPath)) {
                    const destStat = fs.statSync(destPath);
                    if (destStat.isDirectory()) {
                        destPath = path.join(destPath, path.basename(sourcePath));
                    }
                }

                const destParent = path.dirname(destPath);
                if (!fs.existsSync(destParent)) fs.mkdirSync(destParent, { recursive: true, mode: 0o777 });

                fs.renameSync(sourcePath, destPath);
                return reply.status(200).send({ success: true, message: 'Item renamed/moved.' });
            }

            if (action === 'copy') {
                const { file, root = '/' } = req.body;
                if (!file) return reply.status(400).send({ error: 'File is required to copy.' });

                const { targetPath: sourcePath } = resolveSafePath(serverId, path.join(root, file));
                if (!fs.existsSync(sourcePath)) return reply.status(404).send({ error: 'Source file does not exist.' });

                const lstat = fs.lstatSync(sourcePath);
                if (lstat.isSymbolicLink()) {
                    return reply.status(400).send({ error: 'Access denied: Symbolic links cannot be copied.' });
                }
                if (lstat.isDirectory()) {
                    return reply.status(400).send({ error: 'Directories cannot be copied directly.' });
                }

                checkSpace(lstat.size);

                const parsed = path.parse(sourcePath);
                const copyName = `${parsed.name} copy${parsed.ext}`;
                const destPath = path.join(parsed.dir, copyName);

                fs.copyFileSync(sourcePath, destPath);
                return reply.status(200).send({ success: true, message: 'File copied successfully.' });
            }

            if (action === 'chmod') {
                const { file, mode, root = '/' } = req.body;
                if (!file || mode === undefined || mode === null) return reply.status(400).send({ error: 'File and mode are required.' });

                const { targetPath } = resolveSafePath(serverId, path.join(root, file));
                if (!fs.existsSync(targetPath)) return reply.status(404).send({ error: 'Target does not exist.' });

                const lstat = fs.lstatSync(targetPath);
                if (lstat.isSymbolicLink()) {
                    return reply.status(400).send({ error: 'Access denied: Modifying permissions of symbolic links is not permitted.' });
                }

                const modeStr = String(mode).trim();
                if (!/^[0-7]{3,4}$/.test(modeStr)) {
                    return reply.status(400).send({ error: 'Invalid file mode format. Must be an octal permission.' });
                }

                const parsedMode = parseInt(modeStr, 8);
                if (isNaN(parsedMode) || parsedMode < 0 || parsedMode > 0o777 || (parsedMode & 0o7000) !== 0) {
                    return reply.status(400).send({ error: 'Invalid file mode.' });
                }

                fs.chmodSync(targetPath, parsedMode);
                return reply.status(200).send({ success: true, message: 'Permissions updated successfully.' });
            }

            if (action === 'archive') {
                const { files, root = '/', name = `archive-${Date.now()}.tar.gz` } = req.body;
                if (!Array.isArray(files) || files.length === 0) {
                    return reply.status(400).send({ error: 'Files array is required to archive.' });
                }

                if (typeof name !== 'string' || !name || name.startsWith('-')) {
                    return reply.status(400).send({ error: 'Invalid archive name.' });
                }

                checkSpace(0);

                const { targetPath: destArchivePath } = resolveSafePath(serverId, path.join(root, name));
                const { targetPath: workingDir } = resolveSafePath(serverId, root);

                if (!fs.existsSync(workingDir)) {
                    return reply.status(404).send({ error: 'Directory does not exist.' });
                }

                const safeFiles = [];
                for (const item of files) {
                    if (typeof item !== 'string' || !item.trim() || item.startsWith('-')) {
                        return reply.status(400).send({ error: `Invalid file name: ${item}` });
                    }

                    const { targetPath } = resolveSafePath(serverId, path.join(root, item));
                    if (!fs.existsSync(targetPath)) {
                        return reply.status(404).send({ error: `File or folder not found: ${item}` });
                    }

                    const rel = path.relative(workingDir, targetPath);
                    if (rel.startsWith('..') || path.isAbsolute(rel)) {
                        return reply.status(400).send({ error: `Invalid file path: ${item}` });
                    }

                    safeFiles.push(rel);
                }

                if (safeFiles.length === 0) {
                    return reply.status(400).send({ error: 'No valid files selected for archiving.' });
                }

                await new Promise((resolve, reject) => {
                    const tarProc = spawn('tar', ['-czf', destArchivePath, '--', ...safeFiles], { cwd: workingDir });
                    let stderr = '';
                    tarProc.stderr?.on('data', (d) => { stderr += d.toString(); });
                    tarProc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `Tar exited with code ${code}`))));
                    tarProc.on('error', reject);
                });

                return reply.status(200).send({ success: true, message: 'Archive created.', archiveName: name });
            }

            if (action === 'unarchive') {
                const { file, root = '/' } = req.body;
                if (!file) return reply.status(400).send({ error: 'Archive file path required.' });

                const { targetPath: archivePath } = resolveSafePath(serverId, path.join(root, file));
                const { targetPath: destDir } = resolveSafePath(serverId, root);

                if (!fs.existsSync(archivePath)) return reply.status(404).send({ error: 'Archive file not found.' });
                if (!fs.existsSync(destDir)) return reply.status(404).send({ error: 'Destination directory does not exist.' });

                const ext = path.extname(file).toLowerCase();
                let uncompressedSize = 0;
                
                if (ext === '.zip') {
                    uncompressedSize = inspectZipArchive(archivePath);
                } else if (file.endsWith('.tar.gz') || ext === '.tgz' || ext === '.tar') {
                    uncompressedSize = inspectTarArchive(archivePath);
                } else {
                    return reply.status(400).send({ error: 'Unsupported archive format.' });
                }
                
                checkSpace(uncompressedSize);

                const stagingDir = path.join(destDir, `.tmp_extract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
                fs.mkdirSync(stagingDir, { recursive: true, mode: 0o777 });

                try {
                    if (ext === '.zip') {
                        await new Promise((resolve, reject) => {
                            const proc = spawn('unzip', ['-o', '-q', archivePath, '-d', stagingDir]);
                            let stderr = '';
                            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
                            proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `Unzip exited with code ${code}`))));
                            proc.on('error', reject);
                        });
                    } else if (file.endsWith('.tar.gz') || ext === '.tgz' || ext === '.tar') {
                        await new Promise((resolve, reject) => {
                            const proc = spawn('tar', ['-xf', archivePath, '--no-same-owner', '--no-same-permissions', '-C', stagingDir]);
                            let stderr = '';
                            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
                            proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `Tar exited with code ${code}`))));
                            proc.on('error', reject);
                        });
                    }

                    sanitizeExtractedSymlinks(stagingDir, destDir);

                    const extractedItems = fs.readdirSync(stagingDir);
                    for (const item of extractedItems) {
                        const srcPath = path.join(stagingDir, item);
                        const dstPath = path.join(destDir, item);
                        if (fs.existsSync(dstPath)) {
                            fs.rmSync(dstPath, { recursive: true, force: true });
                        }
                        fs.renameSync(srcPath, dstPath);
                    }
                } finally {
                    if (fs.existsSync(stagingDir)) {
                        fs.rmSync(stagingDir, { recursive: true, force: true });
                    }
                }

                return reply.status(200).send({ success: true, message: 'Archive extracted.' });
            }

            return reply.status(400).send({ error: `Unknown file action: ${action}` });
        } catch (err) {
            return reply.status(500).send({ error: sanitizeError(err) });
        }
    }
};
