'use strict';

/**
 * Allmess Integral-V UltraLite PRO (auch als "comfort by Sanibal") – Ultraschall-Waermezaehler.
 *
 * Optische Schnittstelle nach EN 60870-5 mit M-Bus-Protokoll (EN 13757-3), 2400 Baud.
 * Aufwecken mit 0x55 in 8N1 (ca. 2,2 s), danach 8E1. Der Zaehler liefert seine Daten nur nach einem
 * Application Reset (68 04 04 68 53 FE 50 00 A1 16) und REQ_UD2.
 *
 * Telegramm eines echten Zaehlers (Firmware 8, Software 11, November 2026):
 *   0C78 Fabrikationsnummer · 0406 Energie (kWh) · 0C14 Volumen (0,01 m³) · 0B2D Leistung (100 W)
 *   0B3B Durchfluss (l/h) · 0A5A Vorlauf (0,1 °C) · 0A5E Ruecklauf (0,1 °C) · 0B61 Spreizung (0,01 K)
 *   046D Zaehlerzeit · 0227 Betriebstage · 09FD0E Firmware · 09FD0F Software
 * Die Zuordnung erfolgt ueber die Bedeutung (VIF), nicht ueber feste Bytes – andere Skalierungen
 * (z. B. Energie in MWh) werden so ebenfalls richtig umgerechnet.
 *
 * @type {import('./types').ModelDef}
 */
module.exports = {
    id: 'allmess-ultralite-pro',
    label: 'Allmess Integral-V UltraLite PRO (optisch)',
    manufacturer: 'Allmess',
    appReset: true,
    values: [
        {
            quantity: 'energy',
            state: 'Energie',
            name: 'Wärmeenergie (Zählerstand)',
            role: 'value.energy.consumed',
            unit: 'kWh',
            decimals: 3,
            counter: true,
        },
        {
            quantity: 'volume',
            state: 'Volumen',
            name: 'Volumen (Zählerstand)',
            role: 'value.volume',
            unit: 'm³',
            decimals: 3,
        },
        {
            quantity: 'power',
            state: 'Leistung',
            name: 'Wärmeleistung',
            role: 'value.power',
            unit: 'kW',
            decimals: 3,
        },
        {
            quantity: 'volumeFlow',
            state: 'Durchfluss',
            name: 'Durchfluss',
            role: 'value.flow',
            unit: 'l/h',
            decimals: 1,
        },
        {
            quantity: 'flowTemperature',
            state: 'Vorlauf',
            name: 'Vorlauftemperatur',
            role: 'value.temperature',
            unit: '°C',
            decimals: 2,
        },
        {
            quantity: 'returnTemperature',
            state: 'Ruecklauf',
            name: 'Rücklauftemperatur',
            role: 'value.temperature',
            unit: '°C',
            decimals: 2,
        },
        {
            quantity: 'temperatureDifference',
            state: 'Spreizung',
            name: 'Temperaturdifferenz Vorlauf/Rücklauf',
            role: 'value.temperature',
            unit: 'K',
            decimals: 3,
        },
        {
            quantity: 'operatingTime',
            state: 'Betriebszeit',
            name: 'Betriebszeit',
            role: 'value',
            unit: 'd',
            decimals: 2,
        },
        {
            quantity: 'dateTime',
            state: 'Zaehlerzeit',
            name: 'Datum/Uhrzeit im Zähler',
            role: 'value.time',
            type: 'time',
        },
        {
            quantity: 'fabricationNumber',
            state: 'Geraet.Fabrikationsnummer',
            name: 'Fabrikationsnummer',
            role: 'info.serial',
            type: 'string',
        },
        {
            quantity: 'firmwareVersion',
            state: 'Geraet.Firmware',
            name: 'Firmware-Version',
            role: 'info.firmware',
        },
        {
            quantity: 'softwareVersion',
            state: 'Geraet.Software',
            name: 'Software-Version',
            role: 'info.firmware',
        },
    ],
    // Stichtagswerte (Speicher 1): werden vom Zaehler mitgeschickt, sind hier aber nicht gefragt
    ignore: [
        { quantity: 'energy', storage: 1 },
        { quantity: 'volume', storage: 1 },
        { quantity: 'date', storage: 1 },
    ],
};
