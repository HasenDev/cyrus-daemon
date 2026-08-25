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

function getZipUncompressedSize(file) {
    try {
        const out = execFileSync('unzip', ['-l', file], { encoding: 'utf8', stdio: 'pipe' });
        const lines = out.trim().split('\n');
        if (lines.length > 0) {
            const lastLine = lines[lines.length - 1].trim();
            const match = lastLine.split(/\s+/);
            if (match.length >= 1 && /^\d+$/.test(match[0])) {
                return parseInt(match[0], 10);
            }
        }
        return 0;
    } catch {
        return 0;
    }
}

function getTarUncompressedSize(file) {
    try {
        const out = execFileSync('tar', ['-tvf', file], { encoding: 'utf8', stdio: 'pipe' });
        let total = 0;
        out.trim().split('\n').forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3 && /^\d+$/.test(parts[2])) {
                total += parseInt(parts[2], 10);
            }
        });
        return total;
    } catch {
        return 0;
    }
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

                checkSpace(0);

                const { targetPath: destArchivePath } = resolveSafePath(serverId, path.join(root, name));
                const workingDir = resolveSafePath(serverId, root).targetPath;

                await new Promise((resolve, reject) => {
                    const tarProc = spawn('tar', ['-czf', destArchivePath, ...files], { cwd: workingDir });
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

                const ext = path.extname(file).toLowerCase();
                let uncompressedSize = 0;
                
                if (ext === '.zip') uncompressedSize = getZipUncompressedSize(archivePath);
                else uncompressedSize = getTarUncompressedSize(archivePath);
                
                checkSpace(uncompressedSize);

                if (ext === '.zip') {
                    await new Promise((resolve, reject) => {
                        const proc = spawn('unzip', ['-o', archivePath, '-d', destDir]);
                        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unzip exited with code ${code}`))));
                        proc.on('error', reject);
                    });
                } else if (file.endsWith('.tar.gz') || ext === '.tgz' || ext === '.tar') {
                    await new Promise((resolve, reject) => {
                        const proc = spawn('tar', ['-xf', archivePath, '-C', destDir]);
                        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Tar exited with code ${code}`))));
                        proc.on('error', reject);
                    });
                } else {
                    return reply.status(400).send({ error: 'Unsupported archive format.' });
                }

                return reply.status(200).send({ success: true, message: 'Archive extracted.' });
            }

            return reply.status(400).send({ error: `Unknown file action: ${action}` });
        } catch (err) {
            return reply.status(500).send({ error: sanitizeError(err) });
        }
    }
};
