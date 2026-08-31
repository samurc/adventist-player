#!/usr/bin/env node
/*
 * Runner de desarrollo: arranca a la vez
 *   1) el sitio estático con Python  (http.server) en SITE_PORT
 *   2) monitor-server.js (API de edición + build)  en API_PORT
 *
 * Solo usa módulos nativos de Node. Uso: npm run dev
 *
 * Puertos configurables por entorno:
 *   SITE_PORT (por defecto 8000)   -> servidor de Python (el sitio)
 *   PORT      (por defecto 4599)   -> monitor-server.js (la API)
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SITE_PORT = process.env.SITE_PORT || '8000';
const API_PORT = process.env.PORT || '4599';

const procs = [];

function run(name, command, args, extraEnv) {
    const child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env: Object.assign({}, process.env, extraEnv || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tag = `[${name}]`;
    const pipe = (stream, isErr) => {
        stream.setEncoding('utf8');
        let buf = '';
        stream.on('data', (chunk) => {
            buf += chunk;
            const lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach((line) => {
                (isErr ? process.stderr : process.stdout).write(`${tag} ${line}\n`);
            });
        });
        stream.on('end', () => { if (buf) (isErr ? process.stderr : process.stdout).write(`${tag} ${buf}\n`); });
    };
    pipe(child.stdout, false);
    pipe(child.stderr, true);

    child.on('error', (err) => {
        console.error(`${tag} No se pudo iniciar: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
        console.log(`${tag} terminó (code=${code} signal=${signal || '-'})`);
        // Si uno muere, cerramos el otro para no dejar procesos huérfanos.
        shutdown();
    });

    procs.push(child);
    return child;
}

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    procs.forEach((c) => { try { c.kill('SIGTERM'); } catch (_) {} });
    setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('\n  Entorno de desarrollo\n');
console.log(`  Sitio (Python) : http://localhost:${SITE_PORT}/`);
console.log(`  Panel + API    : http://localhost:${API_PORT}/scripts/monitor.html`);
console.log('\n  El panel también funciona abriéndolo desde el sitio de Python:');
console.log(`  http://localhost:${SITE_PORT}/scripts/monitor.html  (llamará a la API en :${API_PORT})`);
console.log('\n  Ctrl+C para detener ambos.\n');

// 1) Sitio con Python
run('site', 'python3', ['-m', 'http.server', SITE_PORT]);
// 2) API + panel con Node
run('api', 'node', [path.join(__dirname, 'monitor-server.js')], { PORT: API_PORT });
