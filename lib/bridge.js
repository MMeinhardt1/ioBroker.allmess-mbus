'use strict';

/**
 * Verbindung zur ESP-Bridge (ESPHome) und Ablauf einer Zaehlerabfrage ueber die optische Schnittstelle.
 *
 * Die Bridge stellt zwei Dinge bereit:
 *  - stream_server (TCP): transparente Verbindung zur UART des IR-Lesekopfs (2400 Baud)
 *  - eine Template-Auswahl (select) im ESPHome-Webserver, mit der das Zeichenformat umgeschaltet
 *    wird: "8N1" zum Aufwecken, "8E1" fuer die M-Bus-Kommunikation.
 *
 * Ablauf: 8N1 -> 0x55 fuer ca. 2,2 s -> warten bis gesendet -> 8E1 -> Application Reset -> REQ_UD2
 * -> Long Frame empfangen. Ueber eine Verbindung mit festem 8E1 laesst sich der Zaehler nicht wecken:
 * das Paritaetsbit liegt dort, wo der Zaehler das Stoppbit erwartet (0x55 hat gerade Paritaet = 0).
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { APP_RESET, reqUd2, findLongFrame } = require('./mbus');

/** 2400 Baud 8N1 = 240 Byte/s, 8E1 = 218 Byte/s */
const BYTES_PER_S_8N1 = 240;
const WAKE_CHUNK = 24;
/** etwas schneller nachschieben als gesendet wird, damit keine Luecken im Wecksignal entstehen */
const WAKE_CHUNK_MS = 90;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * ESPHome-Objekt-ID (altes URL-Format bis ESPHome 2026.6) aus dem Namen.
 *
 * @param {string} name - Name der Entitaet
 * @returns {string} object_id
 */
function objectId(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * ESP-Bridge mit stream_server und umschaltbarem UART-Format.
 */
class Bridge extends EventEmitter {
    /**
     * @param {object} opts - Optionen
     * @param {string} opts.host - IP/Host des ESP
     * @param {number} opts.tcpPort - Port des stream_server
     * @param {number} opts.httpPort - Port des ESPHome-Webservers
     * @param {string} opts.selectName - Name der Auswahl "UART-Format" im ESPHome-YAML
     * @param {string} [opts.httpUser] - Benutzer (Webserver-Auth, Basic)
     * @param {string} [opts.httpPassword] - Passwort
     * @param {{ debug: (m: string) => void, info: (m: string) => void, warn: (m: string) => void }} log - Logger
     */
    constructor(opts, log) {
        super();
        this.opts = opts;
        this.log = log;
        /** @type {net.Socket | null} */
        this.socket = null;
        this.connected = false;
        this.rx = Buffer.alloc(0);
        this._stopped = false;
        this._reconnectTimer = null;
        /** zuletzt erfolgreich verwendetes URL-Format ("name" | "objectId") */
        this._urlStyle = 'name';
    }

    /**
     * TCP-Verbindung aufbauen (und bei Abbruch nach 15 s erneut).
     */
    connect() {
        if (this._stopped || this.socket) {
            return;
        }
        const s = new net.Socket();
        this.socket = s;
        s.setNoDelay(true);
        s.setKeepAlive(true, 30_000);
        s.on('connect', () => {
            this.connected = true;
            this.log.info(`Verbunden mit der Bridge ${this.opts.host}:${this.opts.tcpPort}`);
            this.emit('connection', true);
        });
        s.on('data', d => {
            this.rx = Buffer.concat([this.rx, d]);
            if (this.rx.length > 4096) {
                this.rx = this.rx.subarray(this.rx.length - 4096);
            }
        });
        s.on('error', e => this.log.debug(`TCP: ${e.message}`));
        s.on('close', () => {
            const was = this.connected;
            this.connected = false;
            this.socket = null;
            if (was) {
                this.log.warn('Verbindung zur Bridge getrennt');
                this.emit('connection', false);
            }
            if (!this._stopped) {
                this._reconnectTimer = setTimeout(() => this.connect(), 15_000);
            }
        });
        s.connect(this.opts.tcpPort, this.opts.host);
    }

    /**
     * Verbindung beenden.
     */
    async close() {
        this._stopped = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }

    /**
     * @param {Buffer} data - zu sendende Bytes
     * @returns {Promise<void>}
     */
    _write(data) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                reject(new Error('keine Verbindung zur Bridge'));
                return;
            }
            this.socket.write(data, err => (err ? reject(err) : resolve()));
        });
    }

    /** Empfangspuffer leeren und den Inhalt zurueckgeben. */
    _takeRx() {
        const b = this.rx;
        this.rx = Buffer.alloc(0);
        return b;
    }

    /**
     * Basis-URL und Header fuer den ESPHome-Webserver.
     *
     * @returns {{ base: string, headers: Record<string, string> }} Daten
     */
    _http() {
        /** @type {Record<string, string>} */
        const headers = {};
        if (this.opts.httpUser) {
            headers.Authorization = `Basic ${Buffer.from(`${this.opts.httpUser}:${this.opts.httpPassword || ''}`).toString('base64')}`;
        }
        return { base: `http://${this.opts.host}:${this.opts.httpPort}`, headers };
    }

    /**
     * Entitaets-Pfad im gewaehlten URL-Format.
     *
     * @param {string} style - "name" (ab ESPHome 2026.1) oder "objectId" (bis 2026.6)
     * @returns {string} Pfad
     */
    _selectPath(style) {
        const n = this.opts.selectName;
        return `/select/${style === 'name' ? encodeURIComponent(n) : objectId(n)}`;
    }

    /**
     * Aktuelles UART-Format von der Bridge lesen.
     *
     * @returns {Promise<string | null>} "8N1" / "8E1" oder null
     */
    async getFormat() {
        const { base, headers } = this._http();
        for (const style of [this._urlStyle, this._urlStyle === 'name' ? 'objectId' : 'name']) {
            try {
                const res = await fetch(base + this._selectPath(style), { headers, signal: AbortSignal.timeout(3000) });
                if (res.status === 404) {
                    continue;
                }
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                this._urlStyle = style;
                const j = /** @type {{ value?: string, state?: string }} */ (await res.json());
                return j.value || j.state || null;
            } catch (e) {
                if (e.name === 'TimeoutError') {
                    throw new Error('ESPHome-Webserver antwortet nicht');
                }
                throw e;
            }
        }
        throw new Error(
            `Auswahl "${this.opts.selectName}" auf der Bridge nicht gefunden – ESP mit der Konfiguration aus esphome/ flashen`,
        );
    }

    /**
     * UART-Format umschalten und warten, bis die Bridge es uebernommen hat.
     *
     * @param {'8N1' | '8E1'} fmt - Format
     */
    async setFormat(fmt) {
        const { base, headers } = this._http();
        let ok = false;
        for (const style of [this._urlStyle, this._urlStyle === 'name' ? 'objectId' : 'name']) {
            const res = await fetch(`${base}${this._selectPath(style)}/set?option=${fmt}`, {
                method: 'POST',
                headers,
                signal: AbortSignal.timeout(3000),
            });
            if (res.status === 404) {
                continue;
            }
            if (!res.ok) {
                throw new Error(`Umschalten auf ${fmt}: HTTP ${res.status}`);
            }
            this._urlStyle = style;
            ok = true;
            break;
        }
        if (!ok) {
            throw new Error(
                `Auswahl "${this.opts.selectName}" auf der Bridge nicht gefunden – ESP mit der Konfiguration aus esphome/ flashen`,
            );
        }
        // die Bridge uebernimmt die Auswahl in ihrer Hauptschleife – kurz nachpruefen
        for (let i = 0; i < 10; i++) {
            if ((await this.getFormat()) === fmt) {
                return;
            }
            await sleep(50);
        }
        throw new Error(`Bridge hat das Format ${fmt} nicht übernommen`);
    }

    /**
     * Zaehler auslesen.
     *
     * @param {object} p - Parameter
     * @param {number} p.wakeupMs - Dauer des Wecksignals
     * @param {number} p.pauseMs - Pause nach dem Umschalten auf 8E1
     * @param {boolean} p.appReset - Application Reset vor REQ_UD2 senden
     * @param {number} p.timeoutMs - Wartezeit auf die Antwort
     * @param {(m: string) => void} [p.trace] - Ablauf-Protokoll (debug)
     * @returns {Promise<Buffer>} Long Frame
     */
    async readMeter(p) {
        const trace = p.trace || (() => {});
        if (!this.connected) {
            throw new Error('keine Verbindung zur Bridge');
        }
        try {
            // 1. Aufwecken mit 8N1
            await this.setFormat('8N1');
            const total = Math.ceil((p.wakeupMs / 1000) * BYTES_PER_S_8N1);
            trace(`Wake-up: ${total} x 0x55 (8N1)`);
            const t0 = Date.now();
            const chunk = Buffer.alloc(WAKE_CHUNK, 0x55);
            for (let sent = 0; sent < total; sent += WAKE_CHUNK) {
                await this._write(sent + WAKE_CHUNK <= total ? chunk : chunk.subarray(0, total - sent));
                const due = t0 + ((sent + WAKE_CHUNK) / WAKE_CHUNK) * WAKE_CHUNK_MS;
                await sleep(Math.max(0, due - Date.now()));
            }
            // warten, bis die UART alles gesendet hat (das Umschalten verwirft noch nicht gesendete Bytes)
            const drained = t0 + (total / BYTES_PER_S_8N1) * 1000 + 150;
            await sleep(Math.max(0, drained - Date.now()));

            // 2. auf 8E1 umschalten
            await this.setFormat('8E1');
            await sleep(p.pauseMs);
            const echo = this._takeRx();
            trace(`8E1 aktiv nach ${Date.now() - t0} ms (${echo.length} Byte Echo verworfen)`);

            // 3. Application Reset
            if (p.appReset) {
                await this._write(APP_RESET);
                await sleep(300);
                const ack = this._takeRx();
                trace(
                    `Application Reset: ${ack.includes(0xe5) ? 'E5 erhalten' : `keine Quittung (${ack.length} Byte)`}`,
                );
            }

            // 4. REQ_UD2 und Antwort sammeln
            await this._write(reqUd2());
            const until = Date.now() + p.timeoutMs;
            while (Date.now() < until) {
                await sleep(50);
                const r = findLongFrame(this.rx);
                if (r.status === 'ok') {
                    const frame = Buffer.from(r.frame);
                    this._takeRx();
                    trace(`Antwort: ${frame.length} Byte nach ${Date.now() - t0} ms`);
                    return frame;
                }
            }
            const got = this._takeRx();
            throw new Error(
                got.length
                    ? `unvollständige oder fehlerhafte Antwort (${got.length} Byte: ${got.toString('hex').slice(0, 80)})`
                    : 'keine Antwort vom Zähler (Lesekopf richtig aufgesetzt?)',
            );
        } finally {
            // Bridge immer im M-Bus-Format hinterlassen
            try {
                if ((await this.getFormat()) !== '8E1') {
                    await this.setFormat('8E1');
                }
            } catch (e) {
                this.log.debug(`Zurückschalten auf 8E1: ${e.message}`);
            }
        }
    }
}

module.exports = { Bridge, objectId };
