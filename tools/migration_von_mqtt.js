// Umzug von der bisherigen ESP-Loesung (Werte per MQTT unter mqtt.0.mbus-meter.sensor.*) auf allmess-mbus.0
// Typ: JavaScript (ioBroker-Skript). Voraussetzung: in der javascript-Instanz "Kommando setObject erlauben".
//
// Ablauf:
//  1. ESP mit esphome/wmz-bridge.yaml flashen, allmess-mbus.0 einrichten und eine Abfrage abwarten
//     (legt die Datenpunkte an).
//  2. Dieses Skript mit DRY_RUN = true starten, Log pruefen, dann mit DRY_RUN = false erneut starten.
//
// Was das Skript macht: Fuer jeden bisherigen MQTT-Datenpunkt wird die InfluxDB-Einstellung (inkl. Alias,
// z. B. WMZ_Energie) auf den neuen Datenpunkt uebertragen und beim alten deaktiviert. Gleicher Alias =
// Grafana laeuft unveraendert weiter.
//
// Achtung InfluxDB: Ein Feld behaelt seinen Datentyp. Hat der MQTT-Adapter Werte als Text (string)
// geschrieben, lehnt InfluxDB die neuen Zahlenwerte unter demselben Alias ab. Das Skript prueft den Typ
// des aktuellen alten Werts und uebernimmt in diesem Fall nichts (Meldung im Log) – dann einen neuen Alias
// verwenden oder die alte Messreihe in InfluxDB loeschen.

const DRY_RUN = true;
const ALT = 'mqtt.0.mbus-meter.sensor.';
const NEU = 'allmess-mbus.0.';
const INFLUX = 'influxdb.0';

// alter MQTT-Datenpunkt -> neuer Datenpunkt
const ZIEL = {
    energie_kwh: 'Energie',
    volumen_m3: 'Volumen',
    leistung_kw: 'Leistung',
    durchfluss_l_h: 'Durchfluss',
    vorlauf_grad_c: 'Vorlauf',
    ruecklauf_grad_c: 'Ruecklauf',
    spreizung_k: 'Spreizung',
    betriebszeit_d: 'Betriebszeit',
    fabrikationsnummer: 'Geraet.Fabrikationsnummer',
    firmware_version: 'Geraet.Firmware',
    software_version: 'Geraet.Software',
    zugriffszaehler: 'Geraet.Zugriffszaehler',
    status: 'Geraet.Status',
    status_byte: 'Geraet.Statusbyte',
    fehlversuche: 'info.failures',
};

(async () => {
    let uebernommen = 0;
    for (const [alt, ziel] of Object.entries(ZIEL)) {
        const altId = ALT + alt;
        const altObj = await getObjectAsync(altId);
        const cust = altObj && altObj.common && altObj.common.custom && altObj.common.custom[INFLUX];
        if (!cust || !cust.enabled) {
            continue;
        }
        const neuId = NEU + ziel;
        const neuObj = await getObjectAsync(neuId);
        if (!neuObj) {
            log(`${neuId} fehlt – Adapter einrichten und eine Abfrage abwarten`, 'warn');
            continue;
        }
        const altState = await getStateAsync(altId);
        const altTyp = altState && altState.val !== null ? typeof altState.val : neuObj.common.type;
        if (altTyp !== neuObj.common.type) {
            log(
                `${altId}: Werte vom Typ ${altTyp} ≠ ${neuObj.common.type} (${neuId}) – InfluxDB würde die neuen Werte ` +
                    `unter dem Alias ${cust.aliasId || '-'} ablehnen. Nicht übernommen.`,
                'warn',
            );
            continue;
        }
        log(`${DRY_RUN ? '[DRY] ' : ''}${altId} -> ${neuId} (Alias ${cust.aliasId || '-'})`);
        if (!DRY_RUN) {
            await extendObjectAsync(neuId, { common: { custom: { [INFLUX]: cust } } });
            await extendObjectAsync(altId, { common: { custom: { [INFLUX]: { ...cust, enabled: false } } } });
        }
        uebernommen++;
    }
    log(`${DRY_RUN ? '[DRY] ' : ''}${uebernommen} Influx-Einstellungen übernommen`);
    stopScript();
})();
