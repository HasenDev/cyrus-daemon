const fs = require('fs');
const path = require('path');

function loadRoutes(fastify, dir, prefix = '') {
    if (!fs.existsSync(dir)) {
        console.warn(`[!] Directory not found: ${dir}`);
        return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
            loadRoutes(fastify, fullPath, prefix + '/' + entry.name);
        } else if (entry.name === 'route.js') {
            const routeModule = require(fullPath);
            let routePath = prefix.replace(/\[([^\]]+)\]/g, ':$1') || '/';

            ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].forEach(method => {
                if (routeModule[method]) {
                    fastify.route({
                        method,
                        url: routePath,
                        config: routeModule.rateLimit ? { rateLimit: routeModule.rateLimit } : {},
                        preHandler: routeModule.middleware || [],
                        handler: routeModule[method]
                    });
                    console.log(`[OK] Loaded Daemon Route: [${method}] ${routePath}`);
                }
            });
        }
    }
}

module.exports = loadRoutes;