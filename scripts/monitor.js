/*
 * Monitor de radios para Adventist Player.
 *
 * Lista las estaciones de /api/web.json y comprueba, para cada una, si su
 * stream está activo intentando reproducirlo en el navegador (misma lógica
 * que usa la app: Hls.js para .m3u8, elemento <audio> para el resto).
 *
 * Limitaciones (importantes):
 * - Los streams viven en dominios de terceros sin cabeceras CORS, por lo que
 *   un fetch() normal no puede leer el status code HTTP. La señal fiable de
 *   "activa" es si el navegador consigue abrir el stream y recibir datos.
 * - Los streams servidos por HTTP (no HTTPS) no se pueden comprobar desde una
 *   página HTTPS por "mixed content": se marcan como OMITIDO.
 * - Aun así, se intenta un fetch en modo no-cors en paralelo para distinguir
 *   "servidor inalcanzable" de "servidor responde pero no reproduce".
 */

(function () {
    'use strict';

    const API_URL = '/api/web.json';

    // Estados posibles de cada radio
    const STATUS = {
        PENDING: 'pending',
        CHECKING: 'checking',
        OK: 'ok',
        FAIL: 'fail',
        SKIP: 'skip',
    };

    const STATUS_LABEL = {
        pending: 'Pendiente',
        checking: 'Comprobando...',
        ok: 'Activa',
        fail: 'Caída',
        skip: 'Omitida',
    };

    // --- Estado global ---
    let stations = [];          // datos crudos + estado de comprobación
    let running = false;
    let aborted = false;
    let sortKey = 'index';
    let sortDir = 1;
    let statusFilter = null;    // null = todas
    let searchQuery = '';

    // --- Referencias DOM ---
    const els = {};
    document.addEventListener('DOMContentLoaded', () => {
        els.rows = document.getElementById('rows');
        els.stats = document.getElementById('stats');
        els.progress = document.getElementById('progress');
        els.checkAll = document.getElementById('check-all');
        els.stop = document.getElementById('stop');
        els.recheckFailed = document.getElementById('recheck-failed');
        els.concurrency = document.getElementById('concurrency');
        els.timeout = document.getElementById('timeout');
        els.search = document.getElementById('search');

        els.checkAll.addEventListener('click', () => runChecks(stations.filter(isCheckable)));
        els.stop.addEventListener('click', () => { aborted = true; });
        els.recheckFailed.addEventListener('click', () =>
            runChecks(stations.filter(s => s.status === STATUS.FAIL && isCheckable(s)))
        );
        els.search.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim().toLowerCase();
            render();
        });

        document.querySelectorAll('thead th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.getAttribute('data-sort');
                if (sortKey === key) sortDir *= -1;
                else { sortKey = key; sortDir = 1; }
                render();
            });
        });

        init();
    });

    // --- Carga inicial ---
    async function init() {
        try {
            const res = await fetch(API_URL, { cache: 'no-store' });
            const data = await res.json();
            const pageIsHttps = window.location.protocol === 'https:';

            stations = (data.estaciones || []).map((s, i) => {
                const url = s.medialiveUrl || '';
                const isHls = url.toLowerCase().includes('.m3u8');
                const isHttp = url.startsWith('http://');
                // Un stream HTTP en una página HTTPS no se puede comprobar (mixed content)
                const mixedContent = pageIsHttps && isHttp;

                return {
                    index: i + 1,
                    id: s.id,
                    nombre: s.nombre || '(sin nombre)',
                    pais: s.pais || '',
                    region: s.region || '',
                    dial: s.dial || '',
                    img: s.imgMobile || '',
                    web: s.web || '',
                    url,
                    type: isHls ? 'HLS' : (url ? 'Directo' : '—'),
                    isHls,
                    mixedContent,
                    hasUrl: !!url,
                    // Datos para reintentar estaciones temporales (misma lógica que la app)
                    temporal: !!s.temporal,
                    proveedor: s.proveedor || '',
                    nodo: s.nodo || '',
                    pwd: s.pwd || '',
                    status: STATUS.PENDING,
                    detail: mixedContent ? 'Stream HTTP (mixed content)' : (url ? '' : 'Sin URL de stream'),
                };
            });

            // Los no comprobables arrancan directamente como omitidos
            stations.forEach(s => {
                if (!isCheckable(s)) s.status = STATUS.SKIP;
            });

            render();
        } catch (err) {
            els.rows.innerHTML = `<tr><td colspan="7" style="color:var(--fail)">Error al cargar ${API_URL}: ${escapeHtml(String(err))}</td></tr>`;
        }
    }

    function isCheckable(s) {
        return s.hasUrl && !s.mixedContent;
    }

    // --- Motor de comprobación con concurrencia limitada ---
    async function runChecks(targets) {
        if (running || !targets.length) return;
        running = true;
        aborted = false;
        setControls(true);

        // Reset del estado de los objetivos
        targets.forEach(s => { s.status = STATUS.PENDING; s.detail = ''; });
        render();

        const concurrency = clamp(parseInt(els.concurrency.value, 10) || 6, 1, 20);
        const timeoutMs = clamp(parseInt(els.timeout.value, 10) || 12, 3, 60) * 1000;

        let cursor = 0;
        let done = 0;
        const total = targets.length;

        const worker = async () => {
            while (!aborted) {
                const i = cursor++;
                if (i >= total) break;
                const s = targets[i];
                s.status = STATUS.CHECKING;
                render();
                await checkStation(s, timeoutMs);
                done++;
                updateProgress(done, total);
                render();
            }
        };

        updateProgress(0, total);
        const workers = [];
        for (let i = 0; i < Math.min(concurrency, total); i++) workers.push(worker());
        await Promise.all(workers);

        running = false;
        setControls(false);
        render();
    }

    /*
     * Comprueba una estación. Resuelve mutando s.status y s.detail.
     * Lanza en paralelo:
     *   1) Una prueba de reproducción real (HLS o <audio>) -> señal principal.
     *   2) Un fetch no-cors para saber si el host es alcanzable -> señal auxiliar.
     * La primera que confirme "activa" gana. Si la reproducción falla pero el
     * host respondía, se reporta como caída con esa pista.
     */
    async function checkStation(s, timeoutMs) {
        const started = performance.now();
        const reachability = probeReachability(s.url, timeoutMs);

        const attempt = async (url) => {
            try {
                return url.toLowerCase().includes('.m3u8')
                    ? await checkHls(url, timeoutMs)
                    : await checkAudio(url, timeoutMs);
            } catch (e) {
                return { ok: false, detail: 'Error inesperado' };
            }
        };

        let playResult = await attempt(s.url);

        // Reintento para estaciones temporales: la medialiveUrl caduca, así que si
        // falla resolvemos una URL fresca vía el proveedor (misma lógica que la app)
        // y volvemos a comprobar una única vez.
        let usedTemporalRetry = false;
        if (!playResult.ok && canResolveTemporal(s)) {
            usedTemporalRetry = true;
            const freshUrl = await fetchTemporalStreamUrl(s, timeoutMs);
            if (freshUrl) {
                const retryResult = await attempt(freshUrl);
                if (retryResult.ok) {
                    // Guardamos la URL resuelta para referencia y usamos el resultado del reintento
                    s.resolvedUrl = freshUrl;
                    playResult = retryResult;
                } else {
                    playResult = { ok: false, detail: `${retryResult.detail || 'No reproduce'} (tras resolver temporal)` };
                }
            } else {
                playResult = { ok: false, detail: `${playResult.detail || 'No reproduce'} · no se pudo resolver temporal` };
            }
        }

        const ms = Math.round(performance.now() - started);
        const reachable = await reachability; // ya habrá terminado o estará por hacerlo

        if (playResult.ok) {
            s.status = STATUS.OK;
            s.detail = `Reproduce (${ms} ms)${usedTemporalRetry ? ' · temporal resuelta' : ''}`;
        } else {
            s.status = STATUS.FAIL;
            const hint = reachable === true
                ? 'host responde, no reproduce'
                : reachable === false
                    ? 'host inalcanzable'
                    : 'sin respuesta';
            s.detail = `${playResult.detail || 'No reproduce'} · ${hint}`;
        }
    }

    // ¿Podemos intentar resolver un stream temporal fresco para esta estación?
    function canResolveTemporal(s) {
        return s.temporal && s.proveedor && s.nodo && s.pwd;
    }

    // Réplica de la lógica de la app (fetchTemporalStreamUrl en app.js): pide al
    // proveedor una URL de stream fresca usando nodo + pwd.
    async function fetchTemporalStreamUrl(s, timeoutMs) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const url = `${s.proveedor}?x=${encodeURIComponent(s.nodo)}&password=${encodeURIComponent(s.pwd)}`;
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok) return null;
            const data = await response.json();
            return (data.https && data.https.apple) || (data.http && data.http.apple) || null;
        } catch (error) {
            return null;
        } finally {
            clearTimeout(t);
        }
    }

    // Prueba de alcanzabilidad. En no-cors la respuesta es opaca (sin status),
    // pero si el fetch resuelve sabemos que el servidor contestó algo.
    function probeReachability(url, timeoutMs) {
        return new Promise((resolve) => {
            const controller = new AbortController();
            const t = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
            fetch(url, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' })
                .then(() => { clearTimeout(t); resolve(true); })
                .catch(() => { clearTimeout(t); resolve(false); });
        });
    }

    // Comprobación de streams .m3u8 vía Hls.js (o soporte nativo en Safari)
    function checkHls(url, timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok, detail) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { if (hls) hls.destroy(); } catch (_) {}
                try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
                resolve({ ok, detail });
            };

            const timer = setTimeout(() => finish(false, 'Timeout'), timeoutMs);
            const audio = document.createElement('audio');
            audio.muted = true;
            let hls = null;

            if (window.Hls && window.Hls.isSupported()) {
                hls = new window.Hls({ manifestLoadingTimeOut: timeoutMs, enableWorker: false });
                hls.on(window.Hls.Events.MANIFEST_PARSED, () => finish(true, 'Manifest OK'));
                hls.on(window.Hls.Events.ERROR, (_evt, data) => {
                    if (data && data.fatal) {
                        finish(false, describeHlsError(data));
                    }
                });
                try {
                    hls.loadSource(url);
                    hls.attachMedia(audio);
                } catch (e) {
                    finish(false, 'No se pudo iniciar HLS');
                }
            } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
                // Safari reproduce HLS de forma nativa
                audio.addEventListener('loadedmetadata', () => finish(true, 'Metadata OK'), { once: true });
                audio.addEventListener('error', () => finish(false, mediaErrorText(audio)), { once: true });
                audio.src = url;
                audio.load();
            } else {
                finish(false, 'HLS no soportado');
            }
        });
    }

    // Comprobación de streams directos vía elemento <audio>
    function checkAudio(url, timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const audio = document.createElement('audio');
            audio.muted = true;
            audio.preload = 'auto';

            const finish = (ok, detail) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                audio.removeEventListener('canplay', onOk);
                audio.removeEventListener('loadeddata', onOk);
                audio.removeEventListener('playing', onOk);
                audio.removeEventListener('error', onErr);
                audio.removeEventListener('stalled', onStalled);
                try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (_) {}
                resolve({ ok, detail });
            };

            const onOk = () => finish(true, 'Datos recibidos');
            const onErr = () => finish(false, mediaErrorText(audio));
            const onStalled = () => { /* esperar al timeout; no concluir aún */ };

            const timer = setTimeout(() => finish(false, 'Timeout'), timeoutMs);

            audio.addEventListener('canplay', onOk, { once: true });
            audio.addEventListener('loadeddata', onOk, { once: true });
            audio.addEventListener('playing', onOk, { once: true });
            audio.addEventListener('error', onErr, { once: true });
            audio.addEventListener('stalled', onStalled);

            audio.src = url;
            audio.load();
            // Un intento de play acelera la carga en algunos navegadores; ignoramos su promesa
            const p = audio.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        });
    }

    function describeHlsError(data) {
        if (!data) return 'Error HLS';
        const type = data.type || '';
        const details = data.details || '';
        if (type === 'networkError') return `Red: ${details}`;
        if (type === 'mediaError') return `Media: ${details}`;
        return details || type || 'Error HLS';
    }

    function mediaErrorText(audio) {
        const e = audio && audio.error;
        if (!e) return 'Error de reproducción';
        const map = {
            1: 'Abortado',
            2: 'Error de red',
            3: 'Error de decodificación',
            4: 'Formato no soportado / no disponible',
        };
        return map[e.code] || `Error (código ${e.code})`;
    }

    // --- Render ---
    function render() {
        renderStats();
        renderRows();
    }

    function renderStats() {
        const counts = { total: stations.length, ok: 0, fail: 0, pending: 0, checking: 0, skip: 0 };
        stations.forEach(s => { counts[s.status] = (counts[s.status] || 0) + 1; });

        const chip = (key, label, cls) => {
            const active = statusFilter === key ? ' is-active' : '';
            const count = key === 'total' ? counts.total : (counts[key] || 0);
            return `<span class="chip${active}" data-filter="${key}">
                        ${cls ? `<span class="dot ${cls}"></span>` : ''}${label}: <strong>${count}</strong>
                    </span>`;
        };

        els.stats.innerHTML =
            chip('total', 'Total', '') +
            chip('ok', 'Activas', 'ok') +
            chip('fail', 'Caídas', 'fail') +
            chip('checking', 'Comprobando', 'checking') +
            chip('pending', 'Pendientes', 'pending') +
            chip('skip', 'Omitidas', 'skip');

        els.stats.querySelectorAll('.chip').forEach(c => {
            c.addEventListener('click', () => {
                const f = c.getAttribute('data-filter');
                statusFilter = (f === 'total' || statusFilter === f) ? null : f;
                render();
            });
        });
    }

    function renderRows() {
        let list = stations.slice();

        if (statusFilter) list = list.filter(s => s.status === statusFilter);
        if (searchQuery) {
            list = list.filter(s =>
                s.nombre.toLowerCase().includes(searchQuery) ||
                s.pais.toLowerCase().includes(searchQuery) ||
                s.region.toLowerCase().includes(searchQuery)
            );
        }

        list.sort((a, b) => {
            let va = a[sortKey], vb = b[sortKey];
            if (typeof va === 'string') va = va.toLowerCase();
            if (typeof vb === 'string') vb = vb.toLowerCase();
            if (va < vb) return -1 * sortDir;
            if (va > vb) return 1 * sortDir;
            return 0;
        });

        els.rows.innerHTML = list.map(s => `
            <tr>
                <td>${s.index}</td>
                <td>
                    <div class="name">
                        <img src="${escapeAttr(s.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
                        <div class="meta">
                            <span>${s.web
                                ? `<a href="${escapeAttr(s.web)}" target="_blank" rel="noopener" title="${escapeAttr(s.web)}">${escapeHtml(s.nombre)}</a>`
                                : escapeHtml(s.nombre)}</span>
                            <small>${escapeHtml(s.dial ? (s.region + ' - ' + s.dial) : s.region)}</small>
                        </div>
                    </div>
                </td>
                <td>${escapeHtml(s.pais)}</td>
                <td>${escapeHtml(s.type)}</td>
                <td>
                    <span class="status ${s.status}">
                        <span class="dot ${s.status}"></span>${STATUS_LABEL[s.status] || s.status}
                    </span>
                </td>
                <td class="detail">${escapeHtml(s.detail || '')}</td>
                <td>
                    <a class="url" href="${escapeAttr(s.url)}" target="_blank" rel="noopener" title="${escapeAttr(s.url)}">${escapeHtml(s.url || '—')}</a>
                </td>
            </tr>
        `).join('') || `<tr><td colspan="7" style="color:var(--muted)">Sin resultados.</td></tr>`;
    }

    function updateProgress(done, total) {
        const pct = total ? Math.round((done / total) * 100) : 0;
        els.progress.style.width = pct + '%';
    }

    function setControls(isRunning) {
        els.checkAll.disabled = isRunning;
        els.recheckFailed.disabled = isRunning;
        els.stop.disabled = !isRunning;
        els.concurrency.disabled = isRunning;
        els.timeout.disabled = isRunning;
    }

    // --- Utilidades ---
    function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function escapeAttr(str) {
        return escapeHtml(str).replace(/'/g, '&#39;');
    }
})();
