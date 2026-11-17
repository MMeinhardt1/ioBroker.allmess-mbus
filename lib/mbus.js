'use strict';

/**
 * M-Bus (EN 13757-2/-3) – Telegramme bauen und Long Frames (RSP_UD) generisch dekodieren.
 *
 * Der Parser kennt die gaengigen primaeren VIFs (Energie, Volumen, Leistung, Durchfluss, Temperaturen,
 * Zeiten, Datum/Uhrzeit, Fabrikationsnummer) und einige VIFE-Erweiterungen (0xFD). Werte werden in der
 * Basiseinheit des VIF geliefert (z. B. Wh, m³, W, m³/h, °C). Die Umrechnung in die Zieleinheit
 * (kWh, kW, l/h …) macht das Modell.
 *
 * Kein ioBroker-Bezug: das Modul ist eigenstaendig testbar.
 */

/** Anwendungs-Reset (SND_UD, CI 0x50) an die Broadcast-Adresse 0xFE */
const APP_RESET = Buffer.from([0x68, 0x04, 0x04, 0x68, 0x53, 0xfe, 0x50, 0x00, 0xa1, 0x16]);

/**
 * Short Frame bauen.
 *
 * @param {number} c - C-Feld
 * @param {number} a - Adresse
 * @returns {Buffer} Telegramm
 */
function shortFrame(c, a) {
    return Buffer.from([0x10, c, a, (c + a) & 0xff, 0x16]);
}

/**
 * REQ_UD2 (Daten anfordern).
 *
 * @param {number} [address] - Primaeradresse, Standard 0xFE (Broadcast mit Antwort)
 * @param {boolean} [fcb] - Frame-Count-Bit
 * @returns {Buffer} Telegramm
 */
function reqUd2(address = 0xfe, fcb = false) {
    return shortFrame(fcb ? 0x7b : 0x5b, address);
}

/**
 * Ersten vollstaendigen Long Frame (68 L L 68 … CS 16) in einem Puffer suchen.
 *
 * @param {Buffer} buf - empfangene Bytes
 * @returns {{ status: 'none' | 'incomplete' | 'ok' | 'checksum', frame?: Buffer, start?: number }} Ergebnis
 */
function findLongFrame(buf) {
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] !== 0x68 || buf[i + 3] !== 0x68 || buf[i + 1] !== buf[i + 2] || buf[i + 1] < 3) {
            continue;
        }
        const len = buf[i + 1];
        const total = len + 6;
        if (i + total > buf.length) {
            return { status: 'incomplete', start: i };
        }
        const frame = buf.subarray(i, i + total);
        let cs = 0;
        for (let k = 4; k < 4 + len; k++) {
            cs = (cs + frame[k]) & 0xff;
        }
        if (cs !== frame[4 + len] || frame[5 + len] !== 0x16) {
            // falscher Start (z. B. 0x68 als Datenbyte) – weitersuchen
            continue;
        }
        return { status: 'ok', frame, start: i };
    }
    return { status: buf.includes(0x68) ? 'incomplete' : 'none' };
}

const MEDIUM = {
    0x00: 'Sonstiges',
    0x01: 'Öl',
    0x02: 'Elektrizität',
    0x03: 'Gas',
    0x04: 'Wärme (Rücklauf)',
    0x05: 'Dampf',
    0x06: 'Warmwasser',
    0x07: 'Wasser',
    0x08: 'Heizkostenverteiler',
    0x09: 'Druckluft',
    0x0a: 'Kälte (Rücklauf)',
    0x0b: 'Kälte (Vorlauf)',
    0x0c: 'Wärme (Vorlauf)',
    0x0d: 'Wärme/Kälte',
    0x16: 'Kaltwasser',
};

/**
 * Herstellerkennung (3 Buchstaben) aus dem 16-Bit-Wert.
 *
 * @param {number} m - Wert
 * @returns {string} z. B. "ITR"
 */
function manufacturerCode(m) {
    return [(m >> 10) & 0x1f, (m >> 5) & 0x1f, m & 0x1f].map(c => String.fromCharCode(c + 64)).join('');
}

/**
 * Statusbyte (Header) als Text.
 *
 * @param {number} st - Statusbyte
 * @returns {string} Text
 */
function statusText(st) {
    if (st === 0) {
        return 'OK';
    }
    const t = [];
    if (st & 0x03) {
        t.push((st & 0x03) === 1 ? 'Applikation belegt' : (st & 0x03) === 2 ? 'Applikationsfehler' : 'Alarm');
    }
    if (st & 0x04) {
        t.push('Batterie schwach');
    }
    if (st & 0x08) {
        t.push('Permanenter Fehler');
    }
    if (st & 0x10) {
        t.push('Temporärer Fehler');
    }
    if (st & 0xe0) {
        t.push(`Herstellerbits 0x${(st & 0xe0).toString(16).padStart(2, '0')}`);
    }
    return t.join(', ');
}

/**
 * BCD (little endian) -> Zahl; oberstes Nibble 0xF = negativ. Ungueltige Ziffern -> NaN.
 *
 * @param {Buffer} b - Bytes
 * @returns {number} Wert
 */
function bcd(b) {
    let v = 0;
    let neg = false;
    for (let k = b.length - 1; k >= 0; k--) {
        let hi = b[k] >> 4;
        const lo = b[k] & 0x0f;
        if (k === b.length - 1 && hi === 0x0f) {
            neg = true;
            hi = 0;
        }
        if (hi > 9 || lo > 9) {
            return NaN;
        }
        v = v * 100 + hi * 10 + lo;
    }
    return neg ? -v : v;
}

/**
 * Ganzzahl mit Vorzeichen (little endian, Zweierkomplement).
 *
 * @param {Buffer} b - Bytes
 * @returns {number} Wert
 */
function int(b) {
    let v = 0n;
    for (let k = b.length - 1; k >= 0; k--) {
        v = (v << 8n) | BigInt(b[k]);
    }
    const bits = BigInt(b.length * 8);
    if (b.length && b[b.length - 1] & 0x80) {
        v -= 1n << bits;
    }
    return Number(v);
}

/**
 * Datum Typ G (2 Byte).
 *
 * @param {Buffer} b - Bytes
 * @returns {{ y: number, m: number, d: number } | null} Datum
 */
function dateG(b) {
    const d = b[0] & 0x1f;
    const m = b[1] & 0x0f;
    const y = 2000 + (((b[0] & 0xe0) >> 5) | ((b[1] & 0xf0) >> 1));
    return d && m ? { y, m, d } : null;
}

/**
 * Datum/Uhrzeit Typ F (4 Byte).
 *
 * @param {Buffer} b - Bytes
 * @returns {{ y: number, m: number, d: number, h: number, min: number, invalid: boolean } | null} Zeitpunkt
 */
function dateTimeF(b) {
    const min = b[0] & 0x3f;
    const invalid = (b[0] & 0x80) !== 0;
    const h = b[1] & 0x1f;
    const d = b[2] & 0x1f;
    const m = b[3] & 0x0f;
    const y = 2000 + (((b[2] & 0xe0) >> 5) | ((b[3] & 0xf0) >> 1));
    return d && m ? { y, m, d, h, min, invalid } : null;
}

const pad = n => String(n).padStart(2, '0');

/**
 * Primaeren VIF auswerten.
 *
 * @param {number} v - VIF ohne Erweiterungsbit
 * @returns {{ quantity: string, unit: string, exp: number, type?: 'dateG' | 'dateTimeF' | 'id' }} Bedeutung
 */
function primaryVif(v) {
    const n3 = v & 0x07;
    const n2 = v & 0x03;
    const time = ['s', 'min', 'h', 'd'];
    if (v <= 0x07) {
        return { quantity: 'energy', unit: 'Wh', exp: n3 - 3 };
    }
    if (v <= 0x0f) {
        return { quantity: 'energy', unit: 'J', exp: n3 };
    }
    if (v <= 0x17) {
        return { quantity: 'volume', unit: 'm³', exp: n3 - 6 };
    }
    if (v <= 0x1f) {
        return { quantity: 'mass', unit: 'kg', exp: n3 - 3 };
    }
    if (v <= 0x23) {
        return { quantity: 'onTime', unit: time[n2], exp: 0 };
    }
    if (v <= 0x27) {
        return { quantity: 'operatingTime', unit: time[n2], exp: 0 };
    }
    if (v <= 0x2f) {
        return { quantity: 'power', unit: 'W', exp: n3 - 3 };
    }
    if (v <= 0x37) {
        return { quantity: 'power', unit: 'J/h', exp: n3 };
    }
    if (v <= 0x3f) {
        return { quantity: 'volumeFlow', unit: 'm³/h', exp: n3 - 6 };
    }
    if (v <= 0x47) {
        return { quantity: 'volumeFlow', unit: 'm³/min', exp: n3 - 7 };
    }
    if (v <= 0x4f) {
        return { quantity: 'volumeFlow', unit: 'm³/s', exp: n3 - 9 };
    }
    if (v <= 0x57) {
        return { quantity: 'massFlow', unit: 'kg/h', exp: n3 - 3 };
    }
    if (v <= 0x5b) {
        return { quantity: 'flowTemperature', unit: '°C', exp: n2 - 3 };
    }
    if (v <= 0x5f) {
        return { quantity: 'returnTemperature', unit: '°C', exp: n2 - 3 };
    }
    if (v <= 0x63) {
        return { quantity: 'temperatureDifference', unit: 'K', exp: n2 - 3 };
    }
    if (v <= 0x67) {
        return { quantity: 'externalTemperature', unit: '°C', exp: n2 - 3 };
    }
    if (v <= 0x6b) {
        return { quantity: 'pressure', unit: 'bar', exp: n2 - 3 };
    }
    if (v === 0x6c) {
        return { quantity: 'date', unit: '', exp: 0, type: 'dateG' };
    }
    if (v === 0x6d) {
        return { quantity: 'dateTime', unit: '', exp: 0, type: 'dateTimeF' };
    }
    if (v === 0x6e) {
        return { quantity: 'hcaUnits', unit: '', exp: 0 };
    }
    if (v <= 0x73) {
        return { quantity: 'averagingDuration', unit: time[n2], exp: 0 };
    }
    if (v <= 0x77) {
        return { quantity: 'actualityDuration', unit: time[n2], exp: 0 };
    }
    if (v === 0x78) {
        return { quantity: 'fabricationNumber', unit: '', exp: 0, type: 'id' };
    }
    if (v === 0x79) {
        return { quantity: 'enhancedId', unit: '', exp: 0, type: 'id' };
    }
    if (v === 0x7a) {
        return { quantity: 'busAddress', unit: '', exp: 0 };
    }
    return { quantity: 'unknown', unit: '', exp: 0 };
}

/** VIFE nach 0xFD (Auswahl) */
const VIF_FD = {
    0x0a: 'manufacturerCode',
    0x0b: 'parameterSet',
    0x0c: 'modelVersion',
    0x0d: 'hardwareVersion',
    0x0e: 'firmwareVersion',
    0x0f: 'softwareVersion',
    0x16: 'password',
    0x17: 'errorFlags',
};

/**
 * Wert mit Zehnerpotenz skalieren, ohne Gleitkomma-Artefakte (591.9500000001).
 *
 * @param {number} raw - Rohwert
 * @param {number} exp - Exponent
 * @returns {number} Wert
 */
function scale(raw, exp) {
    if (!exp) {
        return raw;
    }
    const v = raw * 10 ** exp;
    return exp < 0 ? Number(v.toFixed(-exp)) : v;
}

/**
 * Long Frame (RSP_UD) dekodieren.
 *
 * @param {Buffer} frame - vollstaendiger Long Frame inkl. 68 … 16
 * @returns {import('./models/types').MbusTelegram} Telegramm
 */
function parseLongFrame(frame) {
    const L = frame[1];
    const c = frame[4];
    const a = frame[5];
    const ci = frame[6];
    const end = 4 + L; // Index der Pruefsumme
    /** @type {import('./models/types').MbusTelegram} */
    const tg = { c, address: a, ci, header: null, records: [] };
    let p = 7;
    if (ci === 0x72 || ci === 0x76) {
        const h = frame.subarray(7, 19);
        tg.header = {
            id: bcd(h.subarray(0, 4)).toString().padStart(8, '0'),
            manufacturer: manufacturerCode(h[4] | (h[5] << 8)),
            version: h[6],
            medium: h[7],
            mediumText: MEDIUM[h[7]] || `0x${h[7].toString(16).padStart(2, '0')}`,
            access: h[8],
            status: h[9],
            statusText: statusText(h[9]),
            signature: h[10] | (h[11] << 8),
        };
        p = 19;
    } else if (ci === 0x7a) {
        const h = frame.subarray(7, 11);
        tg.header = {
            id: '',
            manufacturer: '',
            version: 0,
            medium: 0,
            mediumText: '',
            access: h[0],
            status: h[1],
            statusText: statusText(h[1]),
            signature: h[2] | (h[3] << 8),
        };
        p = 11;
    } else if (ci !== 0x78) {
        throw new Error(`CI-Feld 0x${ci.toString(16)} wird nicht unterstützt`);
    }

    const lens = [0, 1, 2, 3, 4, 4, 6, 8, 0, 1, 2, 3, 4, 0, 6, 0];
    while (p < end) {
        const recStart = p;
        const dif = frame[p++];
        if (dif === 0x2f) {
            continue; // Fuellbyte
        }
        if ((dif & 0x0f) === 0x0f) {
            // 0x0F/0x1F: Herstellerdaten bis zum Ende
            tg.manufacturerData = frame.subarray(p, end);
            break;
        }
        const code = dif & 0x0f;
        let storage = (dif >> 6) & 0x01;
        let tariff = 0;
        let subunit = 0;
        const fn = (dif >> 4) & 0x03;
        const difes = [];
        let d = dif;
        let k = 0;
        while (d & 0x80 && p < end) {
            d = frame[p++];
            difes.push(d);
            storage |= (d & 0x0f) << (1 + 4 * k);
            tariff |= ((d >> 4) & 0x03) << (2 * k);
            subunit |= ((d >> 6) & 0x01) << k;
            k++;
        }
        if (p >= end) {
            break;
        }
        const vif = frame[p++];
        const vifes = [];
        let v = vif;
        while (v & 0x80 && p < end) {
            v = frame[p++];
            vifes.push(v);
        }
        let n = lens[code];
        if (code === 0x0d) {
            n = frame[p++] & 0x3f; // variable Laenge (nur ASCII/Binaer bis 63 Byte)
        }
        if (p + n > end) {
            break;
        }
        const data = frame.subarray(p, p + n);
        p += n;

        /** @type {import('./models/types').MbusRecord} */
        const rec = {
            key: frame
                .subarray(recStart, recStart + 1 + difes.length + 1 + vifes.length)
                .toString('hex')
                .toUpperCase(),
            raw: frame.subarray(recStart, p).toString('hex').toUpperCase(),
            dif,
            vif,
            vife: vifes,
            storage,
            tariff,
            subunit,
            func: /** @type {const} */ (['inst', 'max', 'min', 'error'])[fn],
            quantity: 'unknown',
            unit: '',
            value: null,
        };

        const base = vif & 0x7f;
        let meaning;
        if (vif === 0xfd && vifes.length) {
            meaning = { quantity: VIF_FD[vifes[0] & 0x7f] || `fd_${(vifes[0] & 0x7f).toString(16)}`, unit: '', exp: 0 };
        } else if (vif === 0xfb || vif === 0xff || vif === 0x7f || vif === 0xfc || vif === 0x7c) {
            meaning = { quantity: 'manufacturerSpecific', unit: '', exp: 0 };
        } else {
            meaning = primaryVif(base);
        }
        rec.quantity = meaning.quantity;
        rec.unit = meaning.unit;

        const isBcd = code >= 0x09 && code <= 0x0e && code !== 0x0d;
        if (meaning.type === 'dateG' && n === 2) {
            const dt = dateG(data);
            rec.value = dt ? `${dt.y}-${pad(dt.m)}-${pad(dt.d)}` : null;
            rec.time = dt ? new Date(dt.y, dt.m - 1, dt.d).getTime() : undefined;
        } else if (meaning.type === 'dateTimeF' && n === 4) {
            const dt = dateTimeF(data);
            rec.value = dt ? `${dt.y}-${pad(dt.m)}-${pad(dt.d)} ${pad(dt.h)}:${pad(dt.min)}` : null;
            rec.time = dt && !dt.invalid ? new Date(dt.y, dt.m - 1, dt.d, dt.h, dt.min).getTime() : undefined;
        } else if (meaning.type === 'id') {
            rec.value = isBcd ? bcd(data).toString() : int(data).toString();
        } else if (code === 0x05 && n === 4) {
            rec.value = scale(data.readFloatLE(0), meaning.exp);
        } else if (code === 0x0d) {
            rec.value = data.toString('hex').toUpperCase();
        } else if (n > 0) {
            const raw = isBcd ? bcd(data) : int(data);
            rec.value = Number.isNaN(raw) ? null : scale(raw, meaning.exp);
        }
        tg.records.push(rec);
    }
    return tg;
}

module.exports = {
    APP_RESET,
    reqUd2,
    shortFrame,
    findLongFrame,
    parseLongFrame,
    statusText,
    manufacturerCode,
    bcd,
    int,
};
