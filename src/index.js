#!/usr/bin/env node

const logger = require('./lib/logger');
const configureCommand = require('./commands/configure');
const startCommand = require('./commands/start');
const diagnosticsCommand = require('./commands/diagnostics');

const args = process.argv.slice(2);
const command = args[0];

async function main() {
    switch (command) {
        case 'configure':
            await configureCommand(args.slice(1));
            break;
        case 'start':
            await startCommand();
            break;
        case 'diagnostics':
            await diagnosticsCommand();
            break;
        default:
            logger.printBanner();
            console.log(`Usage:
  cyrus-daemon ${logger.accent('configure')} --panel-url <URL> --token <TOKEN>   Auto-configure node daemon
  cyrus-daemon ${logger.accent('start')}                                          Start the node daemon
  cyrus-daemon ${logger.accent('diagnostics')}                                    Run environment diagnostic checks
`);
            break;
    }
}

main().catch(err => {
    logger.error(`Fatal execution error: ${err.message}`);
    process.exit(1);
});