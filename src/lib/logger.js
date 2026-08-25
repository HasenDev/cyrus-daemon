const daemonInfo = require('./daemonInformation');

const ACCENT = '\x1b[38;2;11;141;168m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

function printBanner() {
    const banner = `
${ACCENT}${BOLD}   ____                       ____                                   
  / ___|   _ _ __ _   _ ___  |  _ \\  __ _  ___ _ __ ___   ___  _ __  
 | |  | | | | '__| | | / __| | | | |/ _\` |/ _ \\ '_ \` _ \\ / _ \\| '_ \\ 
 | |__| |_| | |  | |_| \\__ \\ | |_| | (_| |  __/ | | | | | (_) | | | |
  \\____\\__, |_|   \\__,_|___/ |____/ \\__,_|\\___|_| |_| |_|\\___/|_| |_|
       |___/                                                         ${RESET}
${DIM}               CyrusPanel Node Container Daemon v${daemonInfo.VERSION}${RESET}
`;
    console.log(banner);
}

const logger = {
    printBanner,
    info: (msg) => console.log(`${ACCENT}[CYRUS]${RESET} ${msg}`),
    success: (msg) => console.log(`${GREEN}[OK]${RESET} ${msg}`),
    warn: (msg) => console.log(`${YELLOW}[WARN]${RESET} ${msg}`),
    error: (msg) => console.log(`${RED}[ERROR]${RESET} ${msg}`),
    debug: (msg) => console.log(`${GRAY}[DEBUG]${RESET} ${msg}`),
    accent: (msg) => `${ACCENT}${msg}${RESET}`,
    bold: (msg) => `${BOLD}${msg}${RESET}`,
    dim: (msg) => `${DIM}${msg}${RESET}`
};

module.exports = logger;
