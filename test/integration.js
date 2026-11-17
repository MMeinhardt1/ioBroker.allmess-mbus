'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { tests } = require('@iobroker/testing');
const { startSimulator } = require('./simulator');

const TCP = 15801;
const HTTP = 15802;

tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
    defineAdditionalTests({ suite }) {
        suite('Abfrage gegen simulierte Bridge', getHarness => {
            let sim;
            before(async () => {
                sim = await startSimulator({ tcpPort: TCP, httpPort: HTTP });
            });
            after(() => sim && sim.close());
            it('liest den Zaehler und legt die Datenpunkte an', async function () {
                this.timeout(90_000);
                const harness = getHarness();
                await harness.changeAdapterConfig('allmess-mbus', {
                    native: {
                        model: 'allmess-ultralite-pro',
                        host: ' 127.0.0.1, ', // typo on purpose: must be cleaned up by the adapter
                        tcpPort: TCP,
                        httpPort: HTTP,
                        selectName: 'UART Format',
                        intervalNormal: 1800,
                        intervalFast: 60,
                        wakeupMs: 2200,
                        pauseMs: 50,
                        responseTimeoutMs: 3000,
                        appReset: true,
                        logRawFrames: true,
                        createUnknownRecords: false,
                    },
                });
                await harness.startAdapterAndWait();
                // erste Abfrage 10 s nach dem Start, dauert ca. 3 s
                await new Promise(r => setTimeout(r, 19_000));
                const ns = 'allmess-mbus.0.';
                const get = async id => (await harness.states.getStateAsync(ns + id))?.val;
                const obj = async id => (await harness.objects.getObjectAsync(ns + id))?.common;
                assert.strictEqual(await get('info.connection'), true);
                assert.strictEqual(await get('info.readOk'), true, String(await get('info.lastError')));
                assert.strictEqual(await get('Energie'), 1389);
                assert.strictEqual((await obj('Energie')).unit, 'kWh');
                assert.strictEqual(await get('Volumen'), 591.95);
                assert.strictEqual(await get('Durchfluss'), 683);
                assert.strictEqual((await obj('Durchfluss')).unit, 'l/h');
                assert.strictEqual(await get('Vorlauf'), 32.3);
                assert.strictEqual(await get('Ruecklauf'), 32.3);
                assert.strictEqual(await get('Spreizung'), 0.01);
                assert.strictEqual(await get('Betriebszeit'), 76);
                assert.strictEqual(await get('Geraet.Fabrikationsnummer'), '26812825');
                assert.strictEqual(await get('Geraet.Status'), 'OK');
                assert.strictEqual(await get('Verbrauch.Waerme_heute'), 0);
                assert.strictEqual(await get('info.mode'), 'normal');
                assert.strictEqual(sim.state.format, '8E1');

                // Schnellabfrage: nur mit freigegebener Messphase
                await harness.states.setStateAsync(`${ns}control.schnellabfrage`, { val: true, ack: false });
                await new Promise(r => setTimeout(r, 1_000));
                assert.strictEqual(await get('info.mode'), 'normal');
                await harness.states.setStateAsync(`${ns}control.messphase`, { val: true, ack: false });
                await new Promise(r => setTimeout(r, 1_000));
                assert.strictEqual(await get('info.mode'), 'schnell');
                assert.strictEqual(await get('info.intervalS'), 60);

                // Taster: sofort auslesen
                const before = sim.state.requests;
                await harness.states.setStateAsync(`${ns}control.auslesen`, { val: true, ack: false });
                await new Promise(r => setTimeout(r, 6_000));
                assert.strictEqual(sim.state.requests, before + 1);
                assert.strictEqual(await get('info.reads'), 2);
            });
        });
    },
});
