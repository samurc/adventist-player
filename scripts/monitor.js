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

    /*
     * La API de edición (radios/build) la sirve monitor-server.js (Node), no el
     * servidor de Python que probablemente uses para el sitio. Para que el panel
     * funcione tanto si lo abres desde el Node como desde Python (otro puerto),
     * resolvemos la base de la API así:
     *   1) ?api=http://host:puerto  en la URL (se recuerda en localStorage)
     *   2) localStorage 'monitor-api-base'
     *   3) Si la página YA se sirve desde monitor-server.js -> rutas relativas
     *   4) Por defecto -> http://<hostname>:4599  (puerto del monitor-server)
     */
    const MONITOR_SERVER_PORT = 4599;

    function resolveApiBase() {
        const params = new URLSearchParams(window.location.search);
        const fromQuery = params.get('api');
        if (fromQuery !== null) {
            const cleaned = fromQuery.replace(/\/$/, '');
            try { localStorage.setItem('monitor-api-base', cleaned); } catch (_) {}
            return cleaned;
        }
        try {
            const saved = localStorage.getItem('monitor-api-base');
            if (saved) return saved.replace(/\/$/, '');
        } catch (_) {}

        // Si ya estamos servidos por el propio monitor-server, usamos rutas relativas.
        if (String(window.location.port) === String(MONITOR_SERVER_PORT)) return '';

        // Servido desde otro origen (p. ej. Python en :8000): apuntamos al Node.
        const host = window.location.hostname || 'localhost';
        return `${window.location.protocol}//${host}:${MONITOR_SERVER_PORT}`;
    }

    const API_BASE = resolveApiBase();
    const RADIOS_URL = API_BASE + '/api/radios';
    const BUILD_URL = API_BASE + '/api/build';

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

        // Edición / build
        els.addRadio = document.getElementById('add-radio');
        els.compile = document.getElementById('compile');
        els.serverStatus = document.getElementById('server-status');
        els.toast = document.getElementById('toast');

        // Modal
        els.modalBackdrop = document.getElementById('modal-backdrop');
        els.modalTitle = document.getElementById('modal-title');
        els.modalClose = document.getElementById('modal-close');
        els.modalCancel = document.getElementById('modal-cancel');
        els.form = document.getElementById('radio-form');
        els.formError = document.getElementById('form-error');
        els.fTemporal = document.getElementById('f-temporal');
        els.temporalFields = document.getElementById('temporal-fields');
        els.langList = document.getElementById('lang-list');

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

        // Acciones de edición
        els.addRadio.addEventListener('click', () => openModal(null));
        els.compile.addEventListener('click', compile);
        els.modalClose.addEventListener('click', closeModal);
        els.modalCancel.addEventListener('click', closeModal);
        els.modalBackdrop.addEventListener('click', (e) => {
            if (e.target === els.modalBackdrop) closeModal();
        });
        els.fTemporal.addEventListener('change', () => {
            els.temporalFields.classList.toggle('hidden', !els.fTemporal.checked);
        });
        els.form.addEventListener('submit', onSubmitForm);

        // Editar desde la tabla (delegación)
        els.rows.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-edit]');
            if (btn) openModal(parseInt(btn.getAttribute('data-edit'), 10));
        });

        checkServer();
        init();
    });

    // --- Carga inicial ---
    async function init() {
        try {
            const res = await fetch(RADIOS_URL, { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const list = data.estaciones || [];
            stations = list.map((s, i) => buildStationState(s, i));
            refreshLangList();
            render();
        } catch (err) {
            els.rows.innerHTML = `<tr><td colspan="8" style="color:var(--fail)">Error al cargar ${RADIOS_URL}: ${escapeHtml(String(err))}. ¿Está corriendo <code>node scripts/monitor-server.js</code>?</td></tr>`;
        }
    }

    // Construye el objeto de estado de una estación a partir de su registro crudo.
    // Conserva el registro crudo completo en `raw` para poder editarlo/reguardarlo.
    function buildStationState(s, i) {
        const pageIsHttps = window.location.protocol === 'https:';
        const url = s.medialiveUrl || '';
        const isHls = url.toLowerCase().includes('.m3u8');
        const isHttp = url.startsWith('http://');
        const mixedContent = pageIsHttps && isHttp;

        return {
            index: i + 1,
            raw: { ...s },
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
            temporal: !!s.temporal,
            proveedor: s.proveedor || '',
            nodo: s.nodo || '',
            pwd: s.pwd || '',
            status: mixedContent || !url ? STATUS.SKIP : STATUS.PENDING,
            detail: mixedContent ? 'Stream HTTP (mixed content)' : (url ? '' : 'Sin URL de stream'),
        };
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

    // --- Edición: modal, guardar y compilar ---

    // Comprueba que el servidor local (con la API de edición) está disponible.
    async function checkServer() {
        try {
            const res = await fetch(RADIOS_URL, { method: 'GET', cache: 'no-store' });
            if (res.ok) {
                els.serverStatus.textContent = 'Servidor local conectado';
                els.serverStatus.className = 'badge ok';
                setEditingEnabled(true);
                return;
            }
            throw new Error('HTTP ' + res.status);
        } catch (_) {
            els.serverStatus.textContent = 'Sin servidor: ejecuta node scripts/monitor-server.js';
            els.serverStatus.className = 'badge bad';
            setEditingEnabled(false);
        }
    }

    function setEditingEnabled(on) {
        els.addRadio.disabled = !on;
        els.compile.disabled = !on;
    }

    // Rellena el datalist de idiomas con los ya existentes
    function refreshLangList() {
        if (!els.langList) return;
        const langs = [...new Set(stations.map(s => s.raw.idioma).filter(Boolean))].sort();
        els.langList.innerHTML = langs.map(l => `<option value="${escapeAttr(l)}"></option>`).join('');
    }

    // Abre el modal. index=null -> añadir; index numérico -> editar esa fila.
    function openModal(index) {
        const editing = typeof index === 'number' && !Number.isNaN(index);
        const station = editing ? stations.find(s => s.index === index) : null;
        const raw = station ? station.raw : {};

        els.modalTitle.textContent = editing ? 'Editar radio' : 'Añadir radio';
        els.formError.textContent = '';
        document.getElementById('f-index').value = editing ? String(index) : '';

        setVal('f-nombre', raw.nombre);
        setVal('f-idioma', raw.idioma);
        setVal('f-pais', raw.pais);
        setVal('f-region', raw.region);
        setVal('f-dial', raw.dial);
        setVal('f-medialiveUrl', raw.medialiveUrl);
        setVal('f-web', raw.web);
        setVal('f-imgMobile', raw.imgMobile);
        setVal('f-celularContacto', raw.celularContacto);
        setVal('f-bandera', raw.bandera);
        els.fTemporal.checked = !!raw.temporal;
        setVal('f-proveedor', raw.proveedor);
        setVal('f-nodo', raw.nodo);
        setVal('f-pwd', raw.pwd);
        els.temporalFields.classList.toggle('hidden', !els.fTemporal.checked);

        els.modalBackdrop.classList.remove('hidden');
    }

    function closeModal() {
        els.modalBackdrop.classList.add('hidden');
    }

    // Construye el registro crudo a partir del formulario. Solo incluye los
    // campos con valor, para no ensuciar radios_list.json con cadenas vacías
    // (excepto los que el esquema espera siempre: dial, region, temporal).
    function collectFormRaw() {
        const raw = {
            idioma: getVal('f-idioma'),
            nombre: getVal('f-nombre'),
            pais: getVal('f-pais'),
            region: getVal('f-region'),
            dial: getVal('f-dial'),
            web: getVal('f-web'),
            medialiveUrl: getVal('f-medialiveUrl'),
            imgMobile: getVal('f-imgMobile'),
            celularContacto: getVal('f-celularContacto'),
            bandera: getVal('f-bandera'),
            temporal: els.fTemporal.checked,
        };
        if (raw.temporal) {
            raw.proveedor = getVal('f-proveedor');
            raw.nodo = getVal('f-nodo');
            raw.pwd = getVal('f-pwd');
        }
        // Quitar opcionales vacíos (mantenemos dial/region/temporal siempre)
        ['web', 'imgMobile', 'celularContacto', 'bandera', 'proveedor', 'nodo', 'pwd'].forEach(k => {
            if (raw[k] !== undefined && String(raw[k]).trim() === '') delete raw[k];
        });
        return raw;
    }

    async function onSubmitForm(e) {
        e.preventDefault();
        els.formError.textContent = '';

        const raw = collectFormRaw();
        // Validación mínima en cliente
        const missing = ['idioma', 'nombre', 'pais', 'medialiveUrl'].filter(k => !raw[k] || !String(raw[k]).trim());
        if (missing.length) {
            els.formError.textContent = 'Faltan campos obligatorios: ' + missing.join(', ');
            return;
        }
        if (raw.temporal && (!raw.proveedor || !raw.nodo || !raw.pwd)) {
            els.formError.textContent = 'Una radio temporal requiere proveedor, nodo y pwd.';
            return;
        }

        // Actualiza el array crudo en memoria
        const idxStr = document.getElementById('f-index').value;
        const editingIndex = idxStr === '' ? null : parseInt(idxStr, 10);

        let rawList = stations.map(s => s.raw);
        if (editingIndex === null) {
            rawList.push(raw);
        } else {
            const pos = stations.findIndex(s => s.index === editingIndex);
            if (pos >= 0) rawList[pos] = raw;
            else rawList.push(raw);
        }

        const ok = await saveRadios(rawList);
        if (ok) {
            closeModal();
            await init();      // recarga desde el servidor (refleja lo guardado)
            toast('Guardado en radios_list.json. Recuerda pulsar "Compilar" para regenerar api/web.json.', 'ok', 5000);
        }
    }

    // Persiste el array completo en radios_list.json
    async function saveRadios(rawList) {
        try {
            const res = await fetch(RADIOS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ estaciones: rawList }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
            return true;
        } catch (err) {
            els.formError.textContent = 'Error al guardar: ' + String(err.message || err);
            toast('Error al guardar: ' + String(err.message || err), 'bad', 6000);
            return false;
        }
    }

    // Ejecuta el build en el servidor -> genera api/web.json
    async function compile() {
        els.compile.disabled = true;
        const original = els.compile.textContent;
        els.compile.textContent = 'Compilando...';
        try {
            const res = await fetch(BUILD_URL, { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error || (data.stderr || ('HTTP ' + res.status)));
            }
            const summary = (data.stdout || '').trim().split('\n').pop() || 'Build completado.';
            toast('Compilado correctamente.\n' + summary, 'ok', 6000);
        } catch (err) {
            toast('Error al compilar: ' + String(err.message || err), 'bad', 8000);
        } finally {
            els.compile.textContent = original;
            els.compile.disabled = false;
        }
    }

    // --- Toast ---
    let toastTimer = null;
    function toast(msg, kind, ms) {
        els.toast.textContent = msg;
        els.toast.className = 'toast ' + (kind || '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms || 4000);
    }

    // Helpers de formulario
    function setVal(id, v) { document.getElementById(id).value = (v === undefined || v === null) ? '' : String(v); }
    function getVal(id) { return document.getElementById(id).value.trim(); }

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
                <td>
                    <button class="link-btn" data-edit="${s.index}">Editar</button>
                </td>
            </tr>
        `).join('') || `<tr><td colspan="8" style="color:var(--muted)">Sin resultados.</td></tr>`;
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
