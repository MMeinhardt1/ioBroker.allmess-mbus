'use strict';

/*
 * ioBroker.allmess-mbus
 * Allmess-Waermezaehler ueber die optische M-Bus-Schnittstelle und eine ESP-Bridge (ESPHome).
 */

const utils = require('@iobroker/adapter-core');
const { Bridge } = require('./lib/bridge');
const { parseLongFrame } = require('./lib/mbus');
const { getModel, convert, findValue, isIgnored } = require('./lib/models');
const { Statistics } = require('./lib/statistics');

/**
 * Check an IPv4 address or host name (same rule as the validator in admin/jsonConfig.json).
 *
 * @param {string} host - cleaned-up host
 * @returns {boolean} true if usable
 */
function isValidHost(host) {
    const ipv4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
    const name =
        /^(?=.{1,253}$)(?!\d+(\.\d+)*$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    return ipv4.test(host) || name.test(host);
}

/**
 * "Wahr" im Sinne eines Ausloesers: true, Zahl > 0, "true"/"on"/"1".
 *
 * @param {ioBroker.StateValue} v - Wert
 * @returns {boolean} aktiv
 */
function truthy(v) {
    if (typeof v === 'number') {
        return v > 0;
    }
    if (typeof v === 'string') {
        return ['true', 'on', '1', 'ein'].includes(v.trim().toLowerCase());
    }
    return v === true;
}

const SCHEDULER_MS = 5_000;
const FIRST_READ_DELAY_MS = 10_000;
const MIN_INTERVAL_S = 15;

/**
 * Adapter fuer Allmess-Waermezaehler.
 */
class AllmessMbus extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter-Optionen
     */
    constructor(options) {
        super({ ...options, name: 'allmess-mbus' });
        /** @type {Bridge | null} */
        this.bridge = null;
        /** @type {import('./lib/models/types').ModelDef | undefined} */
        this.model = undefined;
        /** @type {Statistics | null} */
        this.stats = null;
        this._stopped = false;
        this._busy = false;
        this._timer = null;
        this._lastStart = 0;
        this._nextDue = 0;
        this._trigger = false;
        this._last = new Map();
        this._objects = new Map();
        /** bereits gemeldete unbekannte Datensaetze */
        this._reportedUnknown = new Set();
        this._counters = { reads: 0, failures: 0, consecutive: 0 };
        this._offlineSince = 0;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Adapter gestartet.
     */
    async onReady() {
        const cfg = this.config;
        cfg.host = String(cfg.host || '')
            .trim()
            .replace(/^[a-z]+:\/\//i, '')
            .replace(/^[\s,;]+|[\s,;/]+$/g, '');
        await this.setStateAsync('info.connection', { val: false, ack: true });
        this.model = getModel(cfg.model);
        if (!this.model) {
            this.log.error(`Unbekanntes Modell "${cfg.model}" – bitte in der Instanz-Konfiguration wählen`);
            return;
        }
        if (!isValidHost(cfg.host)) {
            this.log.warn(
                cfg.host
                    ? `Invalid IP address / host name "${cfg.host}" – please check the instance configuration`
                    : 'No IP address configured – please configure the instance',
            );
            return;
        }
        this.log.info(`Modell: ${this.model.label}`);

        await this._createObjects();

        this.stats = new Statistics((rel, val, name, unit, role) => this._put(rel, val, { name, unit, role }));
        await this._restoreStatistics();
        await this._restoreCounters();

        await this.subscribeStatesAsync('control.*');
        if (cfg.fastTriggerState) {
            await this.subscribeForeignStatesAsync(cfg.fastTriggerState);
            try {
                const st = await this.getForeignStateAsync(cfg.fastTriggerState);
                this._trigger = !!st && truthy(st.val);
            } catch (e) {
                this.log.warn(`Auslöser ${cfg.fastTriggerState}: ${e.message}`);
            }
        }

        this.bridge = new Bridge(
            {
                host: cfg.host,
                tcpPort: Number(cfg.tcpPort) || 8888,
                httpPort: Number(cfg.httpPort) || 80,
                selectName: String(cfg.selectName || 'UART Format').trim(),
                httpUser: cfg.httpUser || '',
                httpPassword: cfg.httpPassword || '',
            },
            this.log,
        );
        this.bridge.on('online', (ok, reason) => this._onBridgeOnline(ok, reason));
        this.bridge.start();

        this._nextDue = Date.now() + FIRST_READ_DELAY_MS;
        await this._updateMode();
        this._timer = this.setInterval(() => this._checkDue(), SCHEDULER_MS);
    }

    /**
     * Datenpunkte anlegen.
     */
    async _createObjects() {
        for (const v of this.model.values) {
            await this._ensureObject(v.state, {
                name: v.name,
                type: v.type === 'string' ? 'string' : 'number',
                role: v.role,
                unit: v.unit,
                read: true,
                write: false,
            });
        }
        /** @type {[string, string, ioBroker.CommonType, string, string?][]} */
        const meta = [
            ['Geraet.Identnummer', 'Identnummer (Telegrammkopf)', 'string', 'info.serial'],
            ['Geraet.Hersteller', 'Herstellerkennung', 'string', 'info.manufacturer'],
            ['Geraet.Medium', 'Medium', 'string', 'text'],
            ['Geraet.Version', 'Geräteversion', 'number', 'value'],
            ['Geraet.Status', 'Status des Zählers', 'string', 'text'],
            ['Geraet.Statusbyte', 'Statusbyte (Telegrammkopf)', 'number', 'value'],
            ['Geraet.Zugriffszaehler', 'Zugriffszähler', 'number', 'value'],
            ['info.model', 'Gewähltes Modell', 'string', 'info.name'],
            ['info.readOk', 'Letzte Abfrage erfolgreich', 'boolean', 'indicator'],
            ['info.lastRead', 'Zeitpunkt der letzten Abfrage', 'number', 'date'],
            ['info.lastSuccess', 'Zeitpunkt der letzten erfolgreichen Abfrage', 'number', 'date'],
            ['info.lastError', 'Letzter Fehler', 'string', 'text'],
            ['info.reads', 'Abfragen seit Installation', 'number', 'value'],
            ['info.failures', 'Fehlgeschlagene Abfragen seit Installation', 'number', 'value'],
            ['info.cycleMs', 'Dauer der letzten Abfrage', 'number', 'value', 'ms'],
            ['info.mode', 'Aktuelles Abfrageintervall (normal/schnell)', 'string', 'text'],
            ['info.intervalS', 'Aktuelles Abfrageintervall', 'number', 'value.interval', 's'],
            ['info.nextRead', 'Nächste geplante Abfrage', 'number', 'date'],
            ['info.rawFrame', 'Letztes Telegramm (hex)', 'string', 'text'],
            ['info.offlineSince', 'Bridge nicht erreichbar seit (leer = erreichbar)', 'number', 'date'],
            ['info.offlineReason', 'Grund, warum die Bridge nicht erreichbar ist', 'string', 'text'],
        ];
        for (const [id, name, type, role, unit] of meta) {
            await this._ensureObject(id, { name, type, role, unit, read: true, write: false });
        }
        await this._ensureObject('control.auslesen', {
            name: 'Zähler jetzt auslesen',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
        });
        await this._ensureObject('control.messphase', {
            name: 'Messphase: Schnellabfrage freigeben',
            type: 'boolean',
            role: 'switch.enable',
            read: true,
            write: true,
            def: false,
        });
        await this._ensureObject('control.schnellabfrage', {
            name: 'Schnellabfrage anfordern (z. B. solange die Wärmepumpe läuft)',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
            def: false,
        });
        await this.setStateAsync('info.model', { val: this.model.label, ack: true });
    }

    /**
     * Objekt (und fehlende Ordner darueber) anlegen bzw. aktualisieren – je ID nur einmal pro Start.
     *
     * @param {string} id - relative ID
     * @param {Partial<ioBroker.StateCommon>} common - common
     * @returns {Promise<void>}
     */
    _ensureObject(id, common) {
        let p = this._objects.get(id);
        if (!p) {
            p = (async () => {
                const parts = id.split('.');
                for (let i = 1; i < parts.length; i++) {
                    const fid = parts.slice(0, i).join('.');
                    if (fid === 'info' || this._objects.has(`#${fid}`)) {
                        continue;
                    }
                    this._objects.set(`#${fid}`, Promise.resolve());
                    await this.setObjectNotExistsAsync(fid, {
                        type: 'folder',
                        common: { name: parts[i - 1] },
                        native: {},
                    });
                }
                const c = { ...common };
                if (!c.unit) {
                    delete c.unit;
                }
                await this.extendObjectAsync(id, {
                    type: 'state',
                    common: /** @type {ioBroker.StateCommon} */ (c),
                    native: {},
                });
            })();
            this._objects.set(id, p);
        }
        return p;
    }

    /**
     * Berechneten Wert schreiben (Objekt bei Bedarf anlegen), nur bei Aenderung.
     *
     * @param {string} rel - relative ID
     * @param {ioBroker.StateValue} val - Wert
     * @param {{ name: string, unit?: string, role?: string }} meta - Beschreibung
     */
    _put(rel, val, meta) {
        if (this._last.get(rel) === val) {
            return;
        }
        this._last.set(rel, val);
        const type = typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string';
        this._ensureObject(rel, {
            name: meta.name,
            type,
            role: meta.role || 'value',
            unit: meta.unit,
            read: true,
            write: false,
        })
            .then(() => this.setStateAsync(rel, { val, ack: true }))
            .catch(e => this.log.warn(`Datenpunkt ${rel}: ${e.message}`));
    }

    /**
     * Wert eines vorhandenen Datenpunkts schreiben. Messwerte werden bei jeder Abfrage geschrieben
     * (auch unveraendert), damit der Zeitstempel die letzte Ablesung zeigt.
     *
     * @param {string} rel - relative ID
     * @param {ioBroker.StateValue} val - Wert
     */
    _set(rel, val) {
        this._last.set(rel, val);
        this.setStateAsync(rel, { val, ack: true }).catch(e => this.log.warn(`Datenpunkt ${rel}: ${e.message}`));
    }

    /**
     * Erreichbarkeit der Bridge hat sich geaendert: Datenpunkte setzen, einmalig melden.
     *
     * @param {boolean} ok - erreichbar
     * @param {string} reason - Grund (nur bei offline)
     */
    _onBridgeOnline(ok, reason) {
        const host = `${this.config.host}`;
        this.setState('info.connection', { val: ok, ack: true });
        if (ok) {
            const since = this._offlineSince;
            this._offlineSince = 0;
            this._set('info.offlineSince', null);
            this._set('info.offlineReason', '');
            if (since) {
                const min = Math.round((Date.now() - since) / 60_000);
                this.log.info(`Bridge ${host} wieder erreichbar (war ${min} min offline)`);
            } else {
                this.log.info(`Bridge ${host} erreichbar`);
            }
            return;
        }
        this._offlineSince = Date.now();
        this._set('info.offlineSince', this._offlineSince);
        this._set('info.offlineReason', reason);
        this.log.warn(`Bridge ${host} nicht erreichbar: ${reason}`);
    }

    /**
     * Startwerte der Verbrauchsstatistik aus den eigenen Datenpunkten lesen.
     */
    async _restoreStatistics() {
        try {
            const states = await this.getStatesAsync('Verbrauch.Intern.*');
            /** @type {Record<string, ioBroker.StateValue>} */
            const rel = {};
            for (const [id, st] of Object.entries(states || {})) {
                if (st) {
                    rel[id.slice(this.namespace.length + 1)] = st.val;
                }
            }
            this.stats.restore(rel);
        } catch (e) {
            this.log.warn(`Verbrauchswerte konnten nicht wiederhergestellt werden: ${e.message}`);
        }
    }

    /**
     * Zaehler (Abfragen/Fehler) aus den Datenpunkten uebernehmen.
     */
    async _restoreCounters() {
        for (const [id, key] of [
            ['info.reads', 'reads'],
            ['info.failures', 'failures'],
        ]) {
            const st = await this.getStateAsync(id);
            if (st && typeof st.val === 'number') {
                this._counters[key] = st.val;
            }
        }
    }

    /**
     * Schnellabfrage aktiv? (Messphase freigegeben UND angefordert – per Datenpunkt oder Ausloeser)
     *
     * @returns {Promise<boolean>} schnell
     */
    async _isFast() {
        const phase = await this.getStateAsync('control.messphase');
        if (!phase || !phase.val) {
            return false;
        }
        const req = await this.getStateAsync('control.schnellabfrage');
        return (!!req && !!req.val) || this._trigger;
    }

    /**
     * Intervall bestimmen, Info-Datenpunkte setzen und die naechste Abfrage ggf. vorziehen.
     */
    async _updateMode() {
        const fast = await this._isFast();
        const normal = Math.max(MIN_INTERVAL_S, Number(this.config.intervalNormal) || 1800);
        const quick = Math.max(MIN_INTERVAL_S, Number(this.config.intervalFast) || 60);
        const intervalS = fast ? Math.min(quick, normal) : normal;
        const mode = fast ? 'schnell' : 'normal';
        if (this._last.get('info.mode') !== mode) {
            this.log.info(`Abfrageintervall: ${mode} (${intervalS} s)`);
        }
        this._set('info.mode', mode);
        this._set('info.intervalS', intervalS);
        if (this._lastStart) {
            this._nextDue = this._lastStart + intervalS * 1000;
        }
        this._set('info.nextRead', this._nextDue);
    }

    /**
     * Pruefen, ob eine Abfrage faellig ist.
     */
    _checkDue() {
        if (this._stopped || this._busy || !this.bridge || !this.bridge.online) {
            return;
        }
        if (Date.now() >= this._nextDue) {
            this._read().catch(e => this.log.error(`Abfrage: ${e.message}`));
        }
    }

    /**
     * Eine Abfrage.
     */
    async _read() {
        if (this._busy) {
            this.log.info('Abfrage läuft bereits');
            return;
        }
        this._busy = true;
        const t0 = Date.now();
        this._lastStart = t0;
        await this._updateMode();
        const cfg = this.config;
        try {
            const frame = await this.bridge.readMeter({
                wakeupMs: Math.max(500, Number(cfg.wakeupMs) || 2200),
                pauseMs: Math.max(0, Number(cfg.pauseMs ?? 100)),
                appReset: cfg.appReset !== false && this.model.appReset,
                timeoutMs: Math.max(1000, Number(cfg.responseTimeoutMs) || 3000),
                trace: m => this.log.debug(m),
            });
            const hex = frame.toString('hex').toUpperCase();
            if (cfg.logRawFrames) {
                this.log.info(`Telegramm: ${hex}`);
            }
            this._set('info.rawFrame', hex);
            this._handleTelegram(parseLongFrame(frame));
            this._counters.consecutive = 0;
            this._set('info.readOk', true);
            this._set('info.lastSuccess', Date.now());
            this._set('info.lastError', '');
        } catch (e) {
            this._counters.failures++;
            this._counters.consecutive++;
            this._set('info.failures', this._counters.failures);
            this._set('info.readOk', false);
            this._set('info.lastError', e.message);
            // erste Fehler nur als Info, ab dem dritten in Folge als Warnung
            if (this._counters.consecutive >= 3) {
                this.log.warn(`Abfrage fehlgeschlagen (${this._counters.consecutive}x in Folge): ${e.message}`);
            } else {
                this.log.info(`Abfrage fehlgeschlagen: ${e.message}`);
            }
        } finally {
            this._counters.reads++;
            this._set('info.reads', this._counters.reads);
            this._set('info.lastRead', t0);
            this._set('info.cycleMs', Date.now() - t0);
            this._busy = false;
            await this._updateMode();
        }
    }

    /**
     * Dekodiertes Telegramm in die Datenpunkte schreiben.
     *
     * @param {import('./lib/models/types').MbusTelegram} tg - Telegramm
     */
    _handleTelegram(tg) {
        const h = tg.header;
        if (h) {
            this._set('Geraet.Identnummer', h.id);
            this._set('Geraet.Hersteller', h.manufacturer);
            this._set('Geraet.Medium', h.mediumText);
            this._set('Geraet.Version', h.version);
            this._set('Geraet.Status', h.statusText);
            this._set('Geraet.Statusbyte', h.status);
            this._set('Geraet.Zugriffszaehler', h.access);
            if (h.status & 0x04 && this._last.get('#battery') !== true) {
                this.log.warn('Der Zähler meldet: Batterie schwach');
            }
            this._last.set('#battery', !!(h.status & 0x04));
        }
        let n = 0;
        for (const rec of tg.records) {
            const def = findValue(this.model, rec);
            if (def) {
                const val = this._valueFor(def, rec);
                if (val !== null) {
                    this._set(def.state, val);
                    n++;
                    if (def.counter && typeof val === 'number') {
                        this.stats.onCounter('heat', val);
                    }
                }
                continue;
            }
            if (isIgnored(this.model, rec) || rec.quantity === 'manufacturerSpecific') {
                continue;
            }
            if (!this._reportedUnknown.has(rec.key)) {
                this._reportedUnknown.add(rec.key);
                this.log.info(
                    `Datensatz ohne Zuordnung: ${rec.raw} (${rec.quantity}, Speicher ${rec.storage}, Tarif ${rec.tariff}, Wert ${rec.value}${rec.unit ? ` ${rec.unit}` : ''})`,
                );
            }
            if (this.config.createUnknownRecords && rec.value !== null) {
                const unit = rec.unit || undefined;
                this._put(`Weitere.${rec.key}`, rec.value, {
                    name: `${rec.quantity}${rec.storage ? ` (Speicher ${rec.storage})` : ''}${rec.tariff ? ` (Tarif ${rec.tariff})` : ''}`,
                    unit,
                    role: 'value',
                });
            }
        }
        this.stats.update();
        this.log.debug(`Abfrage ok: ${n} Werte, Zähler ${h ? h.id : '?'}`);
    }

    /**
     * Wert fuer eine Definition aus dem Datensatz berechnen.
     *
     * @param {import('./lib/models/types').ValueDef} def - Definition
     * @param {import('./lib/models/types').MbusRecord} rec - Datensatz
     * @returns {ioBroker.StateValue} Wert (null = nicht verwendbar)
     */
    _valueFor(def, rec) {
        if (def.type === 'time') {
            return rec.time ?? null;
        }
        if (def.type === 'string') {
            return rec.value === null ? null : String(rec.value);
        }
        if (typeof rec.value !== 'number') {
            return null;
        }
        const v = convert(rec.value, rec.unit, def.unit);
        if (v === null) {
            if (!this._reportedUnknown.has(`unit:${def.state}`)) {
                this._reportedUnknown.add(`unit:${def.state}`);
                this.log.warn(`${def.state}: keine Umrechnung von ${rec.unit} nach ${def.unit}`);
            }
            return null;
        }
        const d = def.decimals ?? 3;
        return Math.round(v * 10 ** d) / 10 ** d;
    }

    /**
     * @param {string} id - State-ID
     * @param {ioBroker.State | null | undefined} state - State
     */
    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (id === this.config.fastTriggerState) {
            const t = truthy(state.val);
            if (t !== this._trigger) {
                this._trigger = t;
                this.log.debug(`Auslöser ${id}: ${t ? 'aktiv' : 'inaktiv'}`);
                await this._onModeInput();
            }
            return;
        }
        if (state.ack || !id.startsWith(`${this.namespace}.control.`)) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1);
        if (rel === 'control.auslesen') {
            await this.setStateAsync(rel, { val: false, ack: true });
            if (state.val) {
                if (this._busy) {
                    this.log.info('Abfrage läuft bereits');
                } else if (!this.bridge || !this.bridge.online) {
                    this.log.warn('Auslesen nicht möglich: keine Verbindung zur Bridge');
                } else {
                    this._read().catch(e => this.log.error(`Abfrage: ${e.message}`));
                }
            }
            return;
        }
        if (rel === 'control.messphase' || rel === 'control.schnellabfrage') {
            await this.setStateAsync(rel, { val: truthy(state.val), ack: true });
            await this._onModeInput();
        }
    }

    /**
     * Messphase/Schnellabfrage geaendert: Intervall neu bestimmen.
     */
    async _onModeInput() {
        await this._updateMode();
        this._checkDue();
    }

    /**
     * @param {() => void} callback - Rueckruf
     */
    async onUnload(callback) {
        this._stopped = true;
        try {
            if (this._timer) {
                this.clearInterval(this._timer);
            }
            if (this.bridge) {
                await this.bridge.close();
            }
            await this.setStateAsync('info.connection', { val: false, ack: true });
        } catch {
            // ignorieren
        }
        callback();
    }
}

if (require.main !== module) {
    module.exports = options => new AllmessMbus(options);
} else {
    new AllmessMbus();
}
