const serversRoute = require('./api/servers/route');
const serverIdRoute = require('./api/servers/[id]/route');
const serverPowerRoute = require('./api/servers/[id]/power/route');
const serverFilesRoute = require('./api/servers/[id]/files/route');
const serverReinstallRoute = require('./api/servers/[id]/reinstall/route');
const userRevokeWsRoute = require('./api/user/revoke-ws/route');
const clientFileDownloadRoute = require('./api/client/files/download/route');
const clientFileUploadRoute = require('./api/client/files/upload/route');

function getExportedHandler(mod, method) {
    if (!mod) return null;
    const target = mod.default && typeof mod.default === 'object' ? mod.default : mod;

    return (
        target[method] ||
        target[method.toUpperCase()] ||
        target[method.toLowerCase()] ||
        (method === 'GET' && typeof target === 'function' ? target : null)
    );
}

function registerRoutes(app) {
    const routeDefinitions = [
        { url: '/api/servers', module: serversRoute },
        { url: '/api/servers/:id', module: serverIdRoute },
        { url: '/api/servers/:id/power', module: serverPowerRoute },
        { url: '/api/servers/:id/files', module: serverFilesRoute },
        { url: '/api/servers/:id/reinstall', module: serverReinstallRoute },
        { url: '/api/user/revoke-ws', module: userRevokeWsRoute },
        { url: '/api/client/files/download', module: clientFileDownloadRoute },
        { url: '/api/client/files/upload', module: clientFileUploadRoute }
    ];

    const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

    for (const def of routeDefinitions) {
        const mod = def.module && def.module.default ? { ...def.module, ...def.module.default } : def.module;

        methods.forEach((method) => {
            const handler = getExportedHandler(mod, method);

            if (handler) {
                app.route({
                    method,
                    url: def.url,
                    config: mod.rateLimit ? { rateLimit: mod.rateLimit } : {},
                    preHandler: mod.middleware || [],
                    handler: handler
                });
            }
        });
    }
}

module.exports = registerRoutes;