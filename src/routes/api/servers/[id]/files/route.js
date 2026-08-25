const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { resolveSafePath, getFilePermissions, getMimeType, isArchiveFile } = require('../../../../../lib/files');

function sanitizeError(err) {
    if (!err || !err.message) return 'An unexpected file error occurred.';
    return err.message.replace(/\/var\/lib\/[^\s'"]+/g, 'target');
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
        if (parts.length >= 6) {
            const sizeStr = parts[2];
            if (/^\d+$/.test(sizeStr)) {
                totalSize += parseInt(sizeStr, 10);
            }
        }

        let entryPath = '';
        let linkTarget = null;

        if (line.includes(' -> ')) {
            const split = line.split(' -> ');
            linkTarget = split[1]?.trim();
            const leftParts = split[0].trim().split(/\s+/);
            entryPath = leftParts.slice(5).join(' ');
        } else if (line.includes(' link to ')) {
            const split = line.split(' link to ');
            linkTarget = split[1]?.trim();
            const leftParts = split[0].trim().split(/\s+/);
            entryPath = leftParts.slice(5).join(' ');
        } else {
            const splitParts = parts.slice(5);
            entryPath = splitParts.join(' ');
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

function sanitizeExtractedSymlinks(baseDir) {
    const resolvedBase = path.resolve(baseDir);

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

                    if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
                        fs.unlinkSync(fullPath);
                    }
                } else if (lstat.isDirectory()) {
                    walk(fullPath);
                }
            } catch (_) {}
        }
    }

    walk(resolvedBase);
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

                const stat = fs.statSync(targetPath);
                if (stat.isDirectory()) return reply.status(400).send({ error: 'Target is a directory, not a file.' });

                if (stat.size > 5 * 1024 * 1024) {
                    return reply.status(400).send({ error: 'File exceeds editable size limit (5 MB).' });
                }

                const content = fs.readFileSync(targetPath, 'utf8');
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
                if (fs.existsSync(targetPath)) existingSize = fs.statSync(targetPath).size;
                const newSize = Buffer.byteLength(content || '', 'utf8');
                checkSpace(newSize - existingSize);

                const parentDir = path.dirname(targetPath);
                if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true, mode: 0o777 });

                fs.writeFileSync(targetPath, content || '', 'utf8');
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

                const stat = fs.statSync(sourcePath);
                if (stat.isDirectory()) return reply.status(400).send({ error: 'Directories cannot be copied directly.' });

                checkSpace(stat.size);

                const parsed = path.parse(sourcePath);
                const copyName = `${parsed.name} copy${parsed.ext}`;
                const destPath = path.join(parsed.dir, copyName);

                fs.copyFileSync(sourcePath, destPath);
                return reply.status(200).send({ success: true, message: 'File copied successfully.' });
            }

            if (action === 'chmod') {
                const { file, mode, root = '/' } = req.body;
                if (!file || !mode) return reply.status(400).send({ error: 'File and mode are required.' });

                const { targetPath } = resolveSafePath(serverId, path.join(root, file));
                if (!fs.existsSync(targetPath)) return reply.status(404).send({ error: 'Target does not exist.' });

                fs.chmodSync(targetPath, parseInt(mode.toString(), 8));
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
                    tarProc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Tar exited with code ${code}`))));
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

                if (ext === '.zip') {
                    await new Promise((resolve, reject) => {
                        const proc = spawn('unzip', ['-o', '-q', archivePath, '-d', destDir]);
                        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unzip exited with code ${code}`))));
                        proc.on('error', reject);
                    });
                } else if (file.endsWith('.tar.gz') || ext === '.tgz' || ext === '.tar') {
                    await new Promise((resolve, reject) => {
                        const proc = spawn('tar', ['-xf', archivePath, '--no-same-owner', '--no-same-permissions', '-C', destDir]);
                        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Tar exited with code ${code}`))));
                        proc.on('error', reject);
                    });
                }

                sanitizeExtractedSymlinks(destDir);

                return reply.status(200).send({ success: true, message: 'Archive extracted.' });
            }

            return reply.status(400).send({ error: `Unknown file action: ${action}` });
        } catch (err) {
            return reply.status(500).send({ error: sanitizeError(err) });
        }
    }
};
