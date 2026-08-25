const fastify = require('fastify');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const logger = require('./lib/logger');
const createAuthMiddleware = require('./lib/auth');
const registerRoutes = require('./routes');
const clientWsRoute = require('./routes/client/ws/route');

async function createDaemonServer(config) {
    const isSSL = config.api?.ssl?.enabled &&
                  fs.existsSync(config.api.ssl.cert || '') &&
                  fs.existsSync(config.api.ssl.key || '');

    const fastifyOpts = { logger: false };

    if (isSSL) {
        fastifyOpts.https = {
            cert: fs.readFileSync(config.api.ssl.cert),
            key: fs.readFileSync(config.api.ssl.key)
        };
        logger.info('SSL certificates loaded successfully.');
    }

    const app = fastify(fastifyOpts);

    await app.register(require('@fastify/cors'), { origin: true });
    await app.register(require('@fastify/multipart'), {
        limits: {
            fileSize: 1024 * 1024 * 1024,
            files: 1
        }
    });

    app.decorate('daemonConfig', config);
    const authMiddleware = createAuthMiddleware(config.token);

    app.addHook('onRequest', async (req, reply) => {
        const routeUrl = req.raw?.url || req.url || '';
        if (
            routeUrl.startsWith('/client/ws') ||
            routeUrl.startsWith('/api/client/files/download') ||
            routeUrl.startsWith('/api/client/files/upload')
        ) {
            return;
        }

        if (routeUrl === '/test' || routeUrl.startsWith('/api')) {
            await authMiddleware(req, reply);
        }
    });

    app.get('/test', async (req, reply) => {
        return reply.status(200).send({
            status: 'online',
            daemon: 'cyrus-daemon',
            uuid: config.uuid,
            timestamp: new Date().toISOString()
        });
    });

    app.get('/client/ws', async (req, reply) => {
        return reply.status(426).send({
            error: 'Upgrade Required',
            message: 'This endpoint requires a WebSocket connection (wss://).'
        });
    });

    registerRoutes(app);
    const wss = new WebSocketServer({ noServer: true });

    app.server.on('upgrade', (request, socket, head) => {
        const requestUrl = request.url || '';
        const pathname = requestUrl.split('?')[0];

        if (pathname === '/client/ws') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });

    wss.on('connection', (ws, req) => {
        clientWsRoute(ws, req, config);
    });

    return app;
}

module.exports = createDaemonServer;
