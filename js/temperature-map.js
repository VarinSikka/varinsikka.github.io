/* temperature-map.js
 * Self-contained IIFE for the World Temperature Anomaly Map project page.
 * Depends on: Leaflet.js (loaded before this script in the HTML)
 */
const TempMap = (function () {
    'use strict';

    // ── Constants ────────────────────────────────────────────────────────────

    const DATA_BASE   = '../data/temperature-map';
    // Grid dimensions — overwritten from meta.json at init; defaults match ERA5 0.25°
    let GRID_ROWS = 721;
    let GRID_COLS = 1440;
    // PNGs are reprojected to Web Mercator (EPSG:3857) and clipped to ±85.051°
    const WORLD_BOUNDS = [[-85.051129, -180], [85.051129, 180]];
    const OVERLAY_OPACITY = 0.78;
    const CACHE_MAX   = 30;    // max cached overlays (LRU eviction)
    const PLAY_MS     = 350;   // ms per frame during playback
    const PRELOAD_AHEAD = 5;   // days to preload ahead of current

    // ── State ────────────────────────────────────────────────────────────────

    const state = {
        currentDay:  1,
        isPlaying:   false,
        playTimer:   null,
        mode:        '2025',   // '2025' | 'clim' (WIP)
        meta:        null,
        // LRU cache: stores { overlay, lruTs } keyed by DOY
        overlayCache: {},
        overlayOrder: [],      // DOY keys in LRU order (oldest first)
        // Bin cache: stores { anomaly: Int8Array, max_k: Float32Array, norm_k: Float32Array }
        binCache: {},
    };

    // ── Float16 decoder ──────────────────────────────────────────────────────

    function f16ToF32(u16) {
        const exp  = (u16 >> 10) & 0x1F;
        const frac = u16 & 0x3FF;
        const sign = u16 >> 15 ? -1 : 1;
        if (exp === 0)  return sign * Math.pow(2, -14) * (frac / 1024);
        if (exp === 31) return frac ? NaN : sign * Infinity;
        return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
    }

    function decodeF16Buffer(buffer) {
        const u16 = new Uint16Array(buffer);
        const f32 = new Float32Array(u16.length);
        for (let i = 0; i < u16.length; i++) f32[i] = f16ToF32(u16[i]);
        return f32;
    }

    // ── Leaflet map setup ────────────────────────────────────────────────────

    const map = L.map('tm-map', {
        center: [20, 0],
        zoom: 2,
        minZoom: 1,
        maxZoom: 5,
        worldCopyJump: true,
        zoomControl: true,
    });

    // Dark base tiles (no labels)
    L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
        {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 19,
        }
    ).addTo(map);

    // Country label overlay on top (uses Leaflet's shadowPane so it sits above the anomaly overlay)
    L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
        {
            attribution: '',
            subdomains: 'abcd',
            maxZoom: 19,
            pane: 'shadowPane',
        }
    ).addTo(map);

    let activeOverlay = null;

    // ── Date helpers ─────────────────────────────────────────────────────────

    function doyToDate(doy, year) {
        // Returns a Date object for day-of-year (1-indexed) in the given year.
        return new Date(year, 0, doy);
    }

    function doyToDateString(doy, year) {
        const d = doyToDate(doy, year || 2025);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function padDoy(doy) {
        return String(doy).padStart(3, '0');
    }

    // ── Data loading ─────────────────────────────────────────────────────────

    function isDayAvailable(doy) {
        if (!state.meta) return true; // assume available if meta not loaded
        return state.meta.available_days && state.meta.available_days.includes(doy);
    }

    function evictOverlayIfNeeded() {
        if (state.overlayOrder.length < CACHE_MAX) return;
        const evictDoy = state.overlayOrder.shift();
        const entry = state.overlayCache[evictDoy];
        if (entry && entry.overlay) {
            if (map.hasLayer(entry.overlay)) map.removeLayer(entry.overlay);
            entry.overlay.remove();
        }
        delete state.overlayCache[evictDoy];
    }

    function loadOverlay(doy) {
        if (state.overlayCache[doy]) {
            // Refresh LRU position
            const idx = state.overlayOrder.indexOf(doy);
            if (idx !== -1) state.overlayOrder.splice(idx, 1);
            state.overlayOrder.push(doy);
            return Promise.resolve(state.overlayCache[doy].overlay);
        }
        evictOverlayIfNeeded();
        const url = DATA_BASE + '/overlays/day_' + padDoy(doy) + '.png';
        const overlay = L.imageOverlay(url, WORLD_BOUNDS, {
            opacity: OVERLAY_OPACITY,
            interactive: false,
            crossOrigin: true,
        });
        state.overlayCache[doy] = { overlay };
        state.overlayOrder.push(doy);
        return Promise.resolve(overlay);
    }

    function loadBin(doy) {
        if (state.binCache[doy]) return Promise.resolve(state.binCache[doy]);
        const pad = padDoy(doy);
        const anomUrl  = DATA_BASE + '/daily/day_' + pad + '.bin';
        const tempsUrl = DATA_BASE + '/daily/day_' + pad + '_temps.bin';

        return Promise.all([
            fetch(anomUrl).then(function (r) {
                if (!r.ok) throw new Error('anomaly bin not found');
                return r.arrayBuffer();
            }),
            fetch(tempsUrl).then(function (r) {
                if (!r.ok) throw new Error('temps bin not found');
                return r.arrayBuffer();
            }),
        ]).then(function (buffers) {
            const anomBuf  = buffers[0];
            const tempsBuf = buffers[1];
            // anomBuf: int8 quantized anomaly (1 byte per pixel, ocean = -128)
            const anomaly = new Int8Array(anomBuf);
            // tempsBuf: interleaved float16 pairs [max_k, norm_k, max_k, norm_k, ...]
            const temps = decodeF16Buffer(tempsBuf);
            const max_k  = new Float32Array(GRID_ROWS * GRID_COLS);
            const norm_k = new Float32Array(GRID_ROWS * GRID_COLS);
            for (let i = 0; i < GRID_ROWS * GRID_COLS; i++) {
                max_k[i]  = temps[i * 2];
                norm_k[i] = temps[i * 2 + 1];
            }
            const data = { anomaly, max_k, norm_k };
            state.binCache[doy] = data;
            return data;
        });
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    function showLoading(visible) {
        const el = document.getElementById('tm-loading');
        if (el) el.style.display = visible ? 'block' : 'none';
    }

    function updateSlider(doy) {
        const slider = document.getElementById('tm-slider');
        if (slider) slider.value = doy;
    }

    function updateDateDisplay(doy) {
        const el = document.getElementById('tm-date-display');
        if (el) el.textContent = doyToDateString(doy, 2025);
    }

    function showDay(doy) {
        state.currentDay = doy;
        updateSlider(doy);
        updateDateDisplay(doy);

        if (!isDayAvailable(doy)) {
            // Remove existing overlay; no data for this day
            if (activeOverlay && map.hasLayer(activeOverlay)) {
                map.removeLayer(activeOverlay);
                activeOverlay = null;
            }
            return;
        }

        loadOverlay(doy).then(function (overlay) {
            if (activeOverlay && map.hasLayer(activeOverlay)) {
                map.removeLayer(activeOverlay);
            }
            overlay.addTo(map);
            activeOverlay = overlay;
        });

        // Preload upcoming days (fire-and-forget)
        for (let d = doy + 1; d <= Math.min(365, doy + PRELOAD_AHEAD); d++) {
            if (isDayAvailable(d) && !state.overlayCache[d]) {
                loadOverlay(d);
            }
        }
    }

    // ── Playback ─────────────────────────────────────────────────────────────

    function startPlay() {
        if (state.isPlaying) return;
        state.isPlaying = true;
        const btn = document.getElementById('tm-play-btn');
        if (btn) btn.innerHTML = '&#9646;&#9646;'; // pause icon
        state.playTimer = setInterval(function () {
            let next = state.currentDay + 1;
            if (next > 365) next = 1;
            showDay(next);
        }, PLAY_MS);
    }

    function stopPlay() {
        if (!state.isPlaying) return;
        state.isPlaying = false;
        const btn = document.getElementById('tm-play-btn');
        if (btn) btn.innerHTML = '&#9654;'; // play icon
        clearInterval(state.playTimer);
        state.playTimer = null;
    }

    // ── Click popup ──────────────────────────────────────────────────────────

    map.on('click', function (e) {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        // Map lat/lng to ERA5 grid indices (row 0 = 90°N, col 0 = 180°W)
        const row = Math.round((90 - lat) / 0.25);
        const rawCol = Math.round((lng + 180) / 0.25);
        const clampedRow = Math.max(0, Math.min(GRID_ROWS - 1, row));
        // Wrap longitude for antimeridian panning
        const clampedCol = ((rawCol % GRID_COLS) + GRID_COLS) % GRID_COLS;
        const idx = clampedRow * GRID_COLS + clampedCol;

        showLoading(true);

        loadBin(state.currentDay).then(function (data) {
            showLoading(false);

            if (data.anomaly[idx] === -128) {
                // Sentinel: ocean or no-data pixel
                L.popup()
                    .setLatLng(e.latlng)
                    .setContent(
                        '<div style="font-family:\'Open Sans\',sans-serif;font-size:13px;">' +
                        'Ocean / No data</div>'
                    )
                    .openOn(map);
                return;
            }

            const maxK  = data.max_k[idx];
            const normK = data.norm_k[idx];

            // Convert Kelvin → Fahrenheit
            const maxF  = ((maxK  - 273.15) * 9 / 5 + 32).toFixed(1);
            const normF = ((normK - 273.15) * 9 / 5 + 32).toFixed(1);
            // K difference × 9/5 = °F anomaly
            const anomF = ((maxK - normK) * 9 / 5).toFixed(1);
            const sign  = parseFloat(anomF) >= 0 ? '+' : '';

            const dateStr = doyToDateString(state.currentDay, 2025);

            L.popup()
                .setLatLng(e.latlng)
                .setContent(
                    '<div style="font-family:\'Open Sans\',sans-serif;font-size:13px;line-height:1.7;">' +
                    '<strong>' + dateStr + '</strong><br>' +
                    'Daily high: <strong>' + maxF + '&deg;F</strong><br>' +
                    'Avg high (1991&ndash;2020): <strong>' + normF + '&deg;F</strong><br>' +
                    'Anomaly: <strong>' + sign + anomF + '&deg;F</strong>' +
                    '</div>'
                )
                .openOn(map);
        }).catch(function () {
            showLoading(false);
            L.popup()
                .setLatLng(e.latlng)
                .setContent(
                    '<div style="font-family:\'Open Sans\',sans-serif;font-size:13px;">' +
                    'Data not yet available for this day.</div>'
                )
                .openOn(map);
        });
    });

    // ── Event binding ────────────────────────────────────────────────────────

    document.getElementById('tm-slider').addEventListener('input', function () {
        stopPlay();
        showDay(parseInt(this.value, 10));
    });

    document.getElementById('tm-play-btn').addEventListener('click', function () {
        if (state.isPlaying) {
            stopPlay();
        } else {
            startPlay();
        }
    });

    document.getElementById('tm-mode-2025').addEventListener('click', function () {
        if (state.mode === '2025') return;
        state.mode = '2025';
        document.getElementById('tm-mode-2025').classList.add('tm-btn--active');
        document.getElementById('tm-mode-clim').classList.remove('tm-btn--active');
        showDay(state.currentDay);
    });

    document.getElementById('tm-mode-clim').addEventListener('click', function () {
        state.mode = 'clim';
        document.getElementById('tm-mode-clim').classList.add('tm-btn--active');
        document.getElementById('tm-mode-2025').classList.remove('tm-btn--active');
        // Placeholder: show same data as 2025 mode with a notice
        showDay(state.currentDay);
        setTimeout(function () {
            L.popup()
                .setLatLng(map.getCenter())
                .setContent(
                    '<div style="font-family:\'Open Sans\',sans-serif;font-size:13px;line-height:1.6;">' +
                    '<strong>Yearly Averages mode is coming soon.</strong><br>' +
                    'Currently showing 2025 daily anomaly data as a placeholder.</div>'
                )
                .openOn(map);
        }, 100);
    });

    // ── Initialization ───────────────────────────────────────────────────────

    function init() {
        fetch(DATA_BASE + '/meta.json')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (meta) {
                    state.meta = meta;
                    if (meta.grid_rows) GRID_ROWS = meta.grid_rows;
                    if (meta.grid_cols) GRID_COLS = meta.grid_cols;
                }
                showDay(1);
            })
            .catch(function () {
                // meta.json missing is non-fatal; assume all 365 days available
                showDay(1);
            });
    }

    init();

    // Expose minimal public API for debugging
    return { showDay: showDay, startPlay: startPlay, stopPlay: stopPlay };

}());
