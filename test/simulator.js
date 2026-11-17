'use strict';

/**
 * Simulierte ESP-Bridge mit Zaehler fuer Tests:
 *  - HTTP: ESPHome-Webserver mit der Auswahl "UART Format" (8N1/8E1)
 *  - TCP:  stream_server; dahinter ein Waermezaehler, der nur mit 0x55 in 8N1 aufwacht,
 *          nach einem Application Reset mit E5 quittiert und auf REQ_UD2 ein Telegramm schickt.
 */

const net = require('node:net');
const http = require('node:http');

/** echtes Telegramm eines Integral-V UltraLite PRO */
const FRAME_HEX =
    '684D4D680800722528812692261704770000000C78252881260406' +
    '6D0500000C14959105000B2D0000000B3B8306000A5A23030A5E2303' +
    '0B61010000046D0C16503B02274C0009FD0E0809FD0F110F00006716';

const APP_RESET = '68040468' + '53FE5000A116';
const REQ_UD2 = '105BFE5916';

/**
 * @param {{ tcpPort: number, httpPort: number, selectName?: string, legacyUrls?: boolean }} o - Optionen
 * @returns {Promise<{ close: () => void, state: { format: string, awake: boolean, wakeBytes: number, requests: number, formatLog: string[] } }>} Simulator
 */
async function startSimulator(o) {
    const name = o.selectName || 'UART Format';
    const objectId = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const state = { format: '8E1', awake: false, wakeBytes: 0, requests: 0, formatLog: [], awakeAt: 0 };
    const frame = Buffer.from(FRAME_HEX, 'hex');

    const httpServer = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const parts = url.pathname.split('/').map(decodeURIComponent);
        const ok = parts[1] === 'select' && (o.legacyUrls ? parts[2] === objectId : parts[2] === name);
        if (!ok) {
            res.writeHead(404).end();
            return;
        }
        if (req.method === 'POST' && parts[3] === 'set') {
            const opt = url.searchParams.get('option');
            res.writeHead(200).end();
            // ESPHome uebernimmt die Auswahl in der naechsten Loop-Runde
            setTimeout(() => {
                state.format = opt;
                state.formatLog.push(opt);
                state.wakeBytes = 0;
            }, 20);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `select/${name}`, value: state.format, state: state.format }));
    });

    const tcpServer = net.createServer(sock => {
        let buf = Buffer.alloc(0);
        sock.on('data', d => {
            if (state.format === '8N1') {
                const n = d.filter(b => b === 0x55).length;
                state.wakeBytes += n;
                if (state.wakeBytes >= 400) {
                    state.awake = true;
                    state.awakeAt = Date.now();
                }
                // Reflexion am Zaehlerfenster: ein Teil kommt als Echo zurueck
                sock.write(d.subarray(0, Math.min(4, d.length)));
                return;
            }
            if (state.awake && Date.now() - state.awakeAt > 6000) {
                state.awake = false;
            }
            buf = Buffer.concat([buf, d]);
            const hex = buf.toString('hex').toUpperCase();
            if (hex.includes(APP_RESET)) {
                buf = Buffer.alloc(0);
                if (state.awake) {
                    setTimeout(() => sock.write(Buffer.from([0xe5])), 30);
                }
            } else if (hex.includes(REQ_UD2)) {
                buf = Buffer.alloc(0);
                state.requests++;
                if (state.awake) {
                    // in zwei Teilen senden, wie ueber die UART
                    setTimeout(() => sock.write(frame.subarray(0, 30)), 100);
                    setTimeout(() => sock.write(frame.subarray(30)), 300);
                    state.awake = false;
                }
            }
        });
        sock.on('error', () => {});
    });

    await new Promise(r => httpServer.listen(o.httpPort, '127.0.0.1', r));
    await new Promise(r => tcpServer.listen(o.tcpPort, '127.0.0.1', r));
    return {
        state,
        close: () => {
            httpServer.close();
            tcpServer.close();
        },
    };
}

module.exports = { startSimulator, FRAME_HEX };
