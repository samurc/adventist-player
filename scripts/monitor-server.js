#!/usr/bin/env node
/*
 * Servidor LOCAL para el panel de monitor/edición de radios.
 *
 * Sirve los archivos estáticos del proyecto y expone una pequeña API para
 * editar scripts/radios_list.json y ejecutar el build (scripts/build_radios.js)
 * que genera api/web.json.
 *
 * IMPORTANTE: esta herramienta es SOLO para uso local en tu máquina. Escribe
 * en el disco y ejecuta el build, así que escucha únicamente en 127.0.0.1 y
 * NO debe desplegarse. No forma parte del sitio publicado.
 *
 * Uso:
 *   node scripts/monitor-server.js
 * Luego abre: http://localhost:4599/scripts/monitor.html
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RADIOS_FILE = path.join(__dirname, 'radios_list.json');
const BUILD_SCRIPT = path.join(__dirname, 'build_radios.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4599;
const HOST = '127.0.0.1';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

// Campos permitidos en cada estación. Todo lo demás se descarta al guardar.
const ALLOWED_FIELDS = [
    'idioma', 'nombre', 'pais', 'region', 'dial', 'web', 'medialiveUrl',
    'imgMobile', 'celularContacto', 'bandera', 'temporal',
    'proveedor', 'nodo', 'pwd',
];
const REQUIRED_FIELDS = ['idioma', 'nombre', 'pais', 'medialiveUrl'];

// CORS para uso local: el panel puede servirse desde otro origen (p. ej. el
// servidor de Python del sitio) y aun así llamar a esta API. Reflejamos el
// origen de la petición. Es seguro porque el servidor solo escucha en localhost.
function corsHeaders(req) {
    const origin = req.headers.origin || '*';
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

function sendJson(res, status, obj, req) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    }, req ? corsHeaders(req) : {}));
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let size = 0;
        const MAX = 10 * 1024 * 1024; // 10 MB de tope de seguridad
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX) { reject(new Error('Payload demasiado grande')); req.destroy(); return; }
            data += chunk;
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

// Normaliza y valida el array de estaciones que llega del cliente.
function sanitizeStations(input) {
    if (!Array.isArray(input)) {
        throw new Error('El cuerpo debe ser un array de estaciones.');
    }
    return input.map((raw, i) => {
        if (!raw || typeof raw !== 'object') {
            throw new Error(`El elemento ${i} no es un objeto válido.`);
        }
        const clean = {};
        ALLOWED_FIELDS.forEach((k) => {
            if (raw[k] === undefined || raw[k] === null) return;
            if (k === 'temporal') clean[k] = !!raw[k];
            else clean[k] = String(raw[k]);
        });
        // Defaults para mantener el esquema consistente
        if (clean.dial === undefined) clean.dial = '';
        if (clean.region === undefined) clean.region = '';
        if (clean.temporal === undefined) clean.temporal = false;

        REQUIRED_FIELDS.forEach((k) => {
            if (!clean[k] || !String(clean[k]).trim()) {
                throw new Error(`El elemento ${i} ("${clean.nombre || '?'}") no tiene el campo obligatorio "${k}".`);
            }
        });
        return clean;
    });
}

// --- Handlers de la API ---

function handleGetRadios(req, res) {
    fs.readFile(RADIOS_FILE, 'utf8', (err, data) => {
        if (err) {
            return sendJson(res, 500, { error: `No se pudo leer radios_list.json: ${err.message}` }, req);
        }
        try {
            const json = JSON.parse(data);
            sendJson(res, 200, { estaciones: json }, req);
        } catch (e) {
            sendJson(res, 500, { error: `radios_list.json no es JSON válido: ${e.message}` }, req);
        }
    });
}

async function handlePostRadios(req, res) {
    try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        // Aceptamos tanto un array directo como { estaciones: [...] }
        const arr = Array.isArray(parsed) ? parsed : parsed.estaciones;
        const clean = sanitizeStations(arr);

        // Backup del archivo anterior antes de sobrescribir
        if (fs.existsSync(RADIOS_FILE)) {
            fs.copyFileSync(RADIOS_FILE, RADIOS_FILE + '.bak');
        }
        fs.writeFileSync(RADIOS_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8');
        sendJson(res, 200, { ok: true, count: clean.length }, req);
    } catch (e) {
        sendJson(res, 400, { error: e.message }, req);
    }
}

function handleBuild(req, res) {
    execFile('node', [BUILD_SCRIPT], { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
            return sendJson(res, 500, { ok: false, error: err.message, stdout, stderr }, req);
        }
        sendJson(res, 200, { ok: true, stdout, stderr }, req);
    });
}

// --- Estáticos (con protección contra path traversal) ---

function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel === '/') rel = '/scripts/monitor.html';

    const filePath = path.join(PROJECT_ROOT, rel);
    // Evitar salir de la raíz del proyecto
    if (!filePath.startsWith(PROJECT_ROOT + path.sep) && filePath !== PROJECT_ROOT) {
        return sendJson(res, 403, { error: 'Ruta no permitida' });
    }

    fs.stat(filePath, (err, stat) => {
        // Si es un directorio, servimos su index.html (como hace python http.server)
        if (!err && stat.isDirectory()) {
            const indexPath = path.join(filePath, 'index.html');
            return fs.stat(indexPath, (e2, s2) => {
                if (e2 || !s2.isFile()) {
                    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, corsHeaders(req)));
                    return res.end('404 Not Found: ' + rel);
                }
                streamFile(indexPath, req, res);
            });
        }
        if (err || !stat.isFile()) {
            res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, corsHeaders(req)));
            return res.end('404 Not Found: ' + rel);
        }
        streamFile(filePath, req, res);
    });
}

function streamFile(filePath, req, res) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, Object.assign({
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
    }, corsHeaders(req)));
    fs.createReadStream(filePath).pipe(res);
}

// --- Router ---

const server = http.createServer((req, res) => {
    const { method } = req;
    const urlPath = (req.url || '/').split('?')[0];

    // Preflight CORS
    if (method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req));
        return res.end();
    }

    if (urlPath === '/api/radios' && method === 'GET') return handleGetRadios(req, res);
    if (urlPath === '/api/radios' && method === 'POST') return handlePostRadios(req, res);
    if (urlPath === '/api/build' && method === 'POST') return handleBuild(req, res);

    if (method === 'GET') return serveStatic(req, res, req.url || '/');

    res.writeHead(405, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, corsHeaders(req)));
    res.end('405 Method Not Allowed');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n  ✗ El puerto ${PORT} ya está en uso.`);
        console.error(`    Puede que monitor-server.js ya esté corriendo, o que otro proceso lo ocupe.`);
        console.error(`    Prueba con otro puerto:  PORT=4600 node scripts/monitor-server.js\n`);
    } else {
        console.error('  ✗ Error del servidor:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log('\n  Panel de radios (LOCAL) en marcha');
    console.log(`  → http://localhost:${PORT}/scripts/monitor.html`);
    console.log('\n  Endpoints:');
    console.log('   GET  /api/radios   (lee scripts/radios_list.json)');
    console.log('   POST /api/radios   (guarda scripts/radios_list.json)');
    console.log('   POST /api/build    (ejecuta build_radios.js -> api/web.json)');
    console.log('\n  Ctrl+C para detener.\n');
});
