'use strict';

/**
 * Verbrauchswerte aus den Zaehlerstaenden: heute/gestern, Monat/Vormonat, Jahr/Vorjahr.
 * Startzaehlerstaende werden in Datenpunkten gespeichert, ein Neustart des Adapters unterbricht
 * die Werte daher nicht. (Uebernommen aus ioBroker.siemens-power, Zaehlerarten frei waehlbar.)
 *
 * Die Klasse kennt kein ioBroker: Ausgaben laufen ueber put(). So ist sie testbar.
 */

const PERIODS = [
    { id: 'Tag', cur: 'heute', prev: 'gestern', key: d => ymd(d), txt: ['heute', 'gestern'] },
    {
        id: 'Monat',
        cur: 'Monat',
        prev: 'Vormonat',
        key: d => ymd(d).slice(0, 7),
        txt: ['im laufenden Monat', 'im Vormonat'],
    },
    {
        id: 'Jahr',
        cur: 'Jahr',
        prev: 'Vorjahr',
        key: d => ymd(d).slice(0, 4),
        txt: ['im laufenden Jahr', 'im Vorjahr'],
    },
];
/** Standard: Waermeenergie */
const DEFAULT_KINDS = [{ id: 'heat', name: 'Waerme', label: 'Wärme' }];

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const r3 = x => Math.round(x * 1000) / 1000;

/**
 * Verbrauch je Tag, Monat und Jahr aus den Zaehlerstaenden.
 */
class Statistics {
    /**
     * @param {(rel: string, val: ioBroker.StateValue, name: string, unit?: string, role?: string) => void} put - Wert ausgeben
     * @param {{ id: string, name: string, label: string }[]} [kinds] - Zaehlerarten
     */
    constructor(put, kinds = DEFAULT_KINDS) {
        this.put = put;
        this.kinds = kinds;
        /** aktuelle Zaehlerstaende */
        this.counter = {};
        /** ein kleinerer Wert wird erst beim zweiten Mal in Folge akzeptiert */
        this.pending = {};
        /** Start je Art und Zeitraum: { heat: { Tag: { key, start } } } */
        this.start = Object.fromEntries(kinds.map(k => [k.id, {}]));
    }

    /**
     * Gespeicherte Startwerte uebernehmen.
     *
     * @param {Record<string, ioBroker.StateValue>} st - eigene Datenpunkte (relative ID -> Wert)
     */
    restore(st) {
        for (const k of this.kinds) {
            for (const p of PERIODS) {
                const start = st[`Verbrauch.Intern.${k.name}_Start_${p.id}`];
                const key = st[`Verbrauch.Intern.${k.name}_Zeitraum_${p.id}`];
                if (typeof start === 'number' && typeof key === 'string' && key) {
                    this.start[k.id][p.id] = { key, start };
                }
            }
        }
    }

    /**
     * Zaehlerstand uebernehmen.
     *
     * @param {string} kind - Zaehlerart (id)
     * @param {number} kwh - Zaehlerstand
     */
    onCounter(kind, kwh) {
        const prev = this.counter[kind];
        if (prev == null || kwh >= prev) {
            this.counter[kind] = kwh;
            delete this.pending[kind];
            return;
        }
        if (this.pending[kind] === kwh) {
            this.counter[kind] = kwh;
            delete this.pending[kind];
        } else {
            this.pending[kind] = kwh;
        }
    }

    /**
     * Verbrauchswerte berechnen.
     *
     * @param {number} [nowMs] - Zeitpunkt (fuer Tests)
     */
    update(nowMs) {
        const now = new Date(nowMs ?? Date.now());
        for (const k of this.kinds) {
            const c = this.counter[k.id];
            if (c == null) {
                continue;
            }
            for (const p of PERIODS) {
                const key = p.key(now);
                const s = this.start[k.id][p.id];
                const base = `Verbrauch.${k.name}_`;
                if (!s || s.key !== key || c < s.start) {
                    if (s && s.key !== key && c >= s.start) {
                        this.put(`${base}${p.prev}`, r3(c - s.start), `${k.label} ${p.txt[1]}`, 'kWh', 'value.energy');
                    }
                    this.start[k.id][p.id] = { key, start: c };
                    this.put(
                        `Verbrauch.Intern.${k.name}_Start_${p.id}`,
                        c,
                        `Zählerstand ${k.label} zu Beginn des Zeitraums (${p.id})`,
                        'kWh',
                        'value.energy',
                    );
                    this.put(
                        `Verbrauch.Intern.${k.name}_Zeitraum_${p.id}`,
                        key,
                        `Zeitraum der Startwerte (${p.id})`,
                        '',
                        'text',
                    );
                }
                this.put(
                    `${base}${p.cur}`,
                    r3(c - this.start[k.id][p.id].start),
                    `${k.label} ${p.txt[0]}`,
                    'kWh',
                    'value.energy',
                );
            }
        }
    }
}

module.exports = { Statistics };
