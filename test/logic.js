'use strict';

const assert = require('node:assert');
const { findLongFrame, parseLongFrame, reqUd2, bcd, int, statusText } = require('../lib/mbus');
const { MODELS, convert, findValue, isIgnored } = require('../lib/models');
const { Bridge, objectId } = require('../lib/bridge');
const { Statistics } = require('../lib/statistics');
const { startSimulator, FRAME_HEX } = require('./simulator');

const frame = Buffer.from(FRAME_HEX, 'hex');

describe('M-Bus-Telegramme', () => {
    it('REQ_UD2 an 0xFE', () => {
        assert.strictEqual(reqUd2().toString('hex'), '105bfe5916');
    });
    it('findet den Long Frame hinter Echo und E5', () => {
        const r = findLongFrame(Buffer.concat([Buffer.from([0x55, 0x55, 0xe5]), frame]));
        assert.strictEqual(r.status, 'ok');
        assert.strictEqual(r.start, 3);
        assert.strictEqual(findLongFrame(frame.subarray(0, 40)).status, 'incomplete');
        const bad = Buffer.from(frame);
        bad[30] ^= 1;
        assert.notStrictEqual(findLongFrame(bad).status, 'ok');
    });
    it('BCD, Ganzzahlen, Status', () => {
        assert.strictEqual(bcd(Buffer.from([0x25, 0x28, 0x81, 0x26])), 26812825);
        assert.strictEqual(bcd(Buffer.from([0x12, 0xf0])), -12);
        assert.ok(Number.isNaN(bcd(Buffer.from([0x1a]))));
        assert.strictEqual(int(Buffer.from([0xff, 0xff])), -1);
        assert.strictEqual(int(Buffer.from([0x6d, 0x05, 0x00, 0x00])), 1389);
        assert.strictEqual(statusText(0), 'OK');
        assert.strictEqual(statusText(0x04), 'Batterie schwach');
    });
    it('dekodiert das Telegramm eines UltraLite PRO', () => {
        const tg = parseLongFrame(frame);
        assert.strictEqual(tg.header.id, '26812825');
        assert.strictEqual(tg.header.manufacturer, 'ITR');
        assert.strictEqual(tg.header.mediumText, 'Wärme (Rücklauf)');
        assert.strictEqual(tg.header.access, 0x77);
        const q = Object.fromEntries(tg.records.map(r => [r.quantity, r]));
        assert.strictEqual(q.energy.value, 1389000);
        assert.strictEqual(q.energy.unit, 'Wh');
        assert.strictEqual(q.volume.value, 591.95);
        assert.strictEqual(q.volumeFlow.value, 0.683);
        assert.strictEqual(q.flowTemperature.value, 32.3);
        assert.strictEqual(q.returnTemperature.value, 32.3);
        assert.strictEqual(q.temperatureDifference.value, 0.01);
        assert.strictEqual(q.operatingTime.value, 76);
        assert.strictEqual(q.operatingTime.unit, 'd');
        assert.strictEqual(q.fabricationNumber.value, '26812825');
        assert.strictEqual(q.firmwareVersion.value, 8);
        assert.strictEqual(q.softwareVersion.value, 11);
        assert.strictEqual(q.dateTime.value, '2026-11-16 22:12');
        assert.strictEqual(q.dateTime.time, new Date(2026, 10, 16, 22, 12).getTime());
    });
});

describe('Modell UltraLite PRO', () => {
    const m = MODELS[0];
    it('ordnet alle Datensaetze zu und rechnet um', () => {
        const tg = parseLongFrame(frame);
        const out = {};
        for (const r of tg.records) {
            const d = findValue(m, r);
            assert.ok(d || isIgnored(m, r), `ohne Zuordnung: ${r.raw}`);
            if (d && typeof r.value === 'number') {
                out[d.state] = convert(r.value, r.unit, d.unit);
            }
        }
        assert.strictEqual(out.Energie, 1389);
        assert.strictEqual(out.Volumen, 591.95);
        assert.strictEqual(out.Durchfluss, 683);
        assert.strictEqual(out.Leistung, 0);
        assert.strictEqual(out.Betriebszeit, 76);
    });
    it('eindeutige Datenpunkte', () => {
        const s = m.values.map(v => v.state);
        assert.strictEqual(new Set(s).size, s.length);
    });
    it('Umrechnung MWh/W/J', () => {
        assert.strictEqual(convert(2500, 'W', 'kW'), 2.5);
        assert.strictEqual(convert(1, 'm³/h', 'l/h'), 1000);
        assert.strictEqual(convert(5, 'bar', 'kW'), null);
    });
});

describe('ESPHome-Objekt-ID', () => {
    it('altes URL-Format', () => {
        assert.strictEqual(objectId('UART Format'), 'uart_format');
        assert.strictEqual(objectId('WMZ UART-Format'), 'wmz_uart_format');
    });
});

describe('Bridge gegen Simulator', function () {
    this.timeout(20_000);
    const log = { debug: () => {}, info: () => {}, warn: () => {} };

    /**
     * @param {boolean} legacy - altes URL-Format
     */
    async function run(legacy) {
        const sim = await startSimulator({
            tcpPort: 15700 + (legacy ? 1 : 0),
            httpPort: 15710 + (legacy ? 1 : 0),
            legacyUrls: legacy,
        });
        const b = new Bridge(
            {
                host: '127.0.0.1',
                tcpPort: 15700 + (legacy ? 1 : 0),
                httpPort: 15710 + (legacy ? 1 : 0),
                selectName: 'UART Format',
            },
            log,
        );
        try {
            b.connect();
            for (let i = 0; i < 40 && !b.connected; i++) {
                await new Promise(r => setTimeout(r, 25));
            }
            assert.ok(b.connected, 'TCP verbunden');
            const steps = [];
            const f = await b.readMeter({
                wakeupMs: 2200,
                pauseMs: 50,
                appReset: true,
                timeoutMs: 2000,
                trace: m => steps.push(m),
            });
            assert.strictEqual(f.toString('hex').toUpperCase(), FRAME_HEX);
            assert.deepStrictEqual(sim.state.formatLog, ['8N1', '8E1']);
            assert.strictEqual(sim.state.format, '8E1');
            assert.ok(
                steps.some(s => s.includes('E5 erhalten')),
                steps.join(' | '),
            );
        } finally {
            await b.close();
            sim.close();
        }
    }

    it('liest den Zaehler (Namens-URLs ab ESPHome 2026.1)', () => run(false));
    it('liest den Zaehler (alte object_id-URLs)', () => run(true));

    it('ohne Aufwecken mit 8N1 antwortet der Zaehler nicht, Format bleibt 8E1', async () => {
        const sim = await startSimulator({ tcpPort: 15702, httpPort: 15712 });
        const b = new Bridge({ host: '127.0.0.1', tcpPort: 15702, httpPort: 15712, selectName: 'UART Format' }, log);
        try {
            b.connect();
            for (let i = 0; i < 40 && !b.connected; i++) {
                await new Promise(r => setTimeout(r, 25));
            }
            await assert.rejects(
                b.readMeter({ wakeupMs: 500, pauseMs: 10, appReset: true, timeoutMs: 1000 }),
                /keine Antwort/,
            );
            assert.strictEqual(sim.state.format, '8E1');
        } finally {
            await b.close();
            sim.close();
        }
    });
});

describe('Waermestatistik', () => {
    it('heute/gestern', () => {
        const out = {};
        const s = new Statistics((rel, val) => (out[rel] = val));
        s.onCounter('heat', 1000);
        s.update(new Date(2026, 10, 30, 23, 0).getTime());
        s.onCounter('heat', 1012.5);
        s.update(new Date(2026, 10, 30, 23, 59).getTime());
        assert.strictEqual(out['Verbrauch.Waerme_heute'], 12.5);
        s.onCounter('heat', 1013);
        s.update(new Date(2026, 11, 1, 0, 1).getTime());
        assert.strictEqual(out['Verbrauch.Waerme_gestern'], 13);
        assert.strictEqual(out['Verbrauch.Waerme_Vormonat'], 13);
        assert.strictEqual(out['Verbrauch.Waerme_heute'], 0);
    });
});
