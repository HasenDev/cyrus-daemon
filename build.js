const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const NODE_MODULES_CACHE = path.join(ROOT, 'node_modules/.cache');

const ENTRY_FILE = path.join(ROOT, 'src/index.js');
const BUNDLED_JS = path.join(DIST, 'cyrus-daemon.bundle.js');
const OUTPUT = path.join(DIST, 'cyrus-daemon');
const SEA_CONFIG = path.join(DIST, 'sea-config.json');
const SEA_BLOB = path.join(DIST, 'sea-prep.blob');

const C_RESET = '\x1b[0m';
const C_CYAN = '\x1b[38;2;11;141;168m';
const C_GREEN = '\x1b[32m';
const C_RED = '\x1b[31m';
const C_YELLOW = '\x1b[33m';
const C_GRAY = '\x1b[90m';

function log(step, message) {
    console.log(`${C_CYAN}[Cyrus Daemon Build]${C_RESET} ${C_GRAY}[${step}]${C_RESET} ${message}`);
}

function success(message) {
    console.log(`${C_GREEN}[OK]${C_RESET} ${message}`);
}

function warn(message) {
    console.log(`${C_YELLOW}[WARN]${C_RESET} ${message}`);
}

function error(message) {
    console.error(`${C_RED}[ERROR]${C_RESET} ${message}`);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        shell: false,
        ...options
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} exited with code ${result.status}`
        );
    }
}

function nukeAllCaches() {
    log('0/4', 'Purging all previous build artifacts and caches...');
    if (fs.existsSync(DIST)) {
        fs.rmSync(DIST, { recursive: true, force: true });
    }
    fs.mkdirSync(DIST, { recursive: true });
    if (fs.existsSync(NODE_MODULES_CACHE)) {
        try {
            fs.rmSync(NODE_MODULES_CACHE, { recursive: true, force: true });
        } catch (_) {}
    }

    success('Cache purged.');
}

function cleanupTempFiles() {
    const files = [
        BUNDLED_JS,
        SEA_CONFIG,
        SEA_BLOB
    ];

    for (const file of files) {
        try {
            if (fs.existsSync(file)) {
                fs.rmSync(file, { force: true });
            }
        } catch (_) {}
    }
}

function checkEnvironment() {
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor < 20) {
        throw new Error(
            `Node.js version 20.0.0 or higher is required for Single Executable Applications (SEA). Current: ${process.version}`
        );
    }

    if (process.platform !== 'linux') {
        warn(`Target platform is Linux, but current platform is ${process.platform}. Binary will be built for ${process.platform}.`);
    }

    if (!fs.existsSync(ENTRY_FILE)) {
        throw new Error(`Entry point file not found at: ${ENTRY_FILE}`);
    }
}

async function bundleJavaScript() {
    log('1/4', 'Bundling fresh source code with esbuild...');

    const buildTimestamp = Date.now();

    const buildResult = await esbuild.build({
        entryPoints: [ENTRY_FILE],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: `node${process.versions.node.split('.')[0]}`,
        outfile: BUNDLED_JS,
        minify: false,
        sourcemap: false,
        keepNames: true,
        treeShaking: true,
        mainFields: ['module', 'main'],
        external: [
            'bufferutil',
            'utf-8-validate'
        ],
        banner: {
            js: `
                // Cyrus Daemon Build: ${buildTimestamp}
                var __dirname = typeof __dirname !== 'undefined' ? __dirname : '/';
                var __filename = typeof __filename !== 'undefined' ? __filename : '/cyrus-daemon';
            `
        },
        logLevel: 'warning'
    });

    if (buildResult.errors && buildResult.errors.length > 0) {
        throw new Error('esbuild encountered errors while bundling.');
    }

    let code = fs.readFileSync(BUNDLED_JS, 'utf8');
    code = code.replace(/^#!.*\r?\n/gm, '');
    code = code.trimStart();

    fs.writeFileSync(BUNDLED_JS, code, 'utf8');

    success(`Fresh JavaScript bundle created: ${path.relative(ROOT, BUNDLED_JS)}`);
}

async function buildSEA() {
    log('2/4', 'Generating SEA blob (V8 Code Cache DISABLED)...');
    const config = {
        main: BUNDLED_JS,
        output: SEA_BLOB,
        disableExperimentalSEAWarning: true,
        useCodeCache: false
    };

    fs.writeFileSync(
        SEA_CONFIG,
        JSON.stringify(config, null, 2),
        'utf8'
    );

    run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);

    if (!fs.existsSync(SEA_BLOB)) {
        throw new Error('SEA preparation blob was not created.');
    }

    success('Fresh SEA blob created.');
}

async function injectExecutable() {
    log('3/4', 'Creating standalone binary with postject...');

    if (fs.existsSync(OUTPUT)) {
        fs.rmSync(OUTPUT, { force: true });
    }

    fs.copyFileSync(process.execPath, OUTPUT);

    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

    run(npxCmd, [
        'postject',
        OUTPUT,
        'NODE_SEA_BLOB',
        SEA_BLOB,
        '--sentinel-fuse',
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
    ]);

    success('Injected fresh SEA payload into binary.');
}

async function finalizePermissions() {
    log('4/4', 'Setting executable permissions...');

    if (process.platform !== 'win32') {
        fs.chmodSync(OUTPUT, 0o755);
    }

    success('Permissions configured.');
}

async function bundle() {
    console.log('');
    console.log(`${C_CYAN}===============================================${C_RESET}`);
    console.log(`${C_CYAN}         Cyrus Daemon Standalone Builder       ${C_RESET}`);
    console.log(`${C_CYAN}===============================================${C_RESET}`);
    console.log(`${C_GRAY}Runtime Node  :${C_RESET} ${process.version}`);
    console.log(`${C_GRAY}Architecture  :${C_RESET} ${process.arch}`);
    console.log(`${C_GRAY}Platform      :${C_RESET} ${process.platform}`);
    console.log(`${C_GRAY}Target Output :${C_RESET} ${path.relative(ROOT, OUTPUT)}`);
    console.log('');

    try {
        checkEnvironment();
        nukeAllCaches();

        await bundleJavaScript();
        await buildSEA();
        await injectExecutable();
        await finalizePermissions();

        cleanupTempFiles();

        const stats = fs.statSync(OUTPUT);

        console.log('');
        success('Build complete with zero caching!');
        console.log('');
        console.log(`  ${C_CYAN}Binary Path :${C_RESET} ${OUTPUT}`);
        console.log(`  ${C_CYAN}File Size   :${C_RESET} ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`  ${C_CYAN}Executable  :${C_RESET} chmod +x confirmed`);
        console.log('');
        console.log(`  ${C_GRAY}Run with:${C_RESET} ./dist/cyrus-daemon`);
        console.log('');
    } catch (err) {
        cleanupTempFiles();

        console.log('');
        error('Build failed.');
        console.error(err);
        console.log('');

        process.exit(1);
    }
}

bundle();