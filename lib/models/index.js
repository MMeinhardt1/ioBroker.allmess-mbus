'use strict';

/**
 * Liste aller unterstuetzten Zaehler. Ein neues Modell:
 *  1. Datei unter lib/models/ anlegen (Vorlage: allmess-ultralite-pro.js).
 *  2. Hier in MODELS eintragen.
 *  3. In admin/jsonConfig.json beim Dropdown "model" ergaenzen.
 */

/** @type {import('./types').ModelDef[]} */
const MODELS = [require('./allmess-ultralite-pro')];

/**
 * Modell anhand der ID holen.
 *
 * @param {string} id - Modell-ID aus der Konfiguration
 * @returns {import('./types').ModelDef | undefined} Modell
 */
function getModel(id) {
    return MODELS.find(m => m.id === id);
}

/** Umrechnung Basiseinheit (laut VIF) -> Zieleinheit */
const CONVERT = {
    Wh: { kWh: 1e-3, MWh: 1e-6 },
    J: { kWh: 1 / 3.6e6, MWh: 1 / 3.6e9, GJ: 1e-9 },
    W: { kW: 1e-3 },
    'J/h': { kW: 1 / 3.6e6, W: 1 / 3600 },
    'm³/h': { 'l/h': 1e3 },
    'm³/min': { 'm³/h': 60, 'l/h': 6e4 },
    'm³/s': { 'm³/h': 3600, 'l/h': 3.6e6 },
    'm³': { l: 1e3 },
    s: { d: 1 / 86400, h: 1 / 3600, min: 1 / 60 },
    min: { d: 1 / 1440, h: 1 / 60 },
    h: { d: 1 / 24 },
    d: { h: 24 },
};

/**
 * Wert in die Zieleinheit umrechnen.
 *
 * @param {number} value - Wert in der Basiseinheit
 * @param {string} from - Basiseinheit
 * @param {string} [to] - Zieleinheit
 * @returns {number | null} umgerechneter Wert oder null, wenn keine Umrechnung bekannt ist
 */
function convert(value, from, to) {
    if (!to || from === to) {
        return value;
    }
    const f = CONVERT[from] && CONVERT[from][to];
    return f === undefined ? null : value * f;
}

/**
 * Passende Wertdefinition zu einem Datensatz suchen.
 *
 * @param {import('./types').ModelDef} model - Modell
 * @param {import('./types').MbusRecord} rec - Datensatz
 * @returns {import('./types').ValueDef | undefined} Definition
 */
function findValue(model, rec) {
    return model.values.find(
        v =>
            v.quantity === rec.quantity &&
            (v.storage ?? 0) === rec.storage &&
            (v.tariff ?? 0) === rec.tariff &&
            (v.func ?? 'inst') === rec.func &&
            rec.subunit === 0,
    );
}

/**
 * Datensatz bewusst ignorieren?
 *
 * @param {import('./types').ModelDef} model - Modell
 * @param {import('./types').MbusRecord} rec - Datensatz
 * @returns {boolean} true = nicht ausgeben, nicht als unbekannt melden
 */
function isIgnored(model, rec) {
    return (model.ignore || []).some(i => i.quantity === rec.quantity && (i.storage ?? rec.storage) === rec.storage);
}

module.exports = { MODELS, getModel, convert, findValue, isIgnored };
