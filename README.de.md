![Logo](admin/allmess-mbus.png)

# ioBroker.allmess-mbus

**[English version](README.md)**

Adapter für Allmess-Wärmezähler (Integral-V UltraLite PRO, auch als „comfort by Sanibal“) über die **optische M-Bus-Schnittstelle**. Ein ESP32 mit ESPHome dient als Bridge zum IR-Schreib-/Lesekopf; alles andere macht der Adapter: Zähler wecken, Daten anfordern und dekodieren, Intervalle und Datenpunkte.

## Funktionsweise

```
Zähler ⟿ IR ⟿ TTL-Lesekopf ── UART ── ESP32 (ESPHome)  ──── LAN ──── ioBroker (allmess-mbus)
                                        • stream_server (TCP, 2400 Baud)
                                        • Auswahl „UART Format“ 8N1/8E1 (REST)
```

Der Zähler wacht nur auf `0x55` in **8N1** (ca. 2,2 s) auf, spricht danach aber M-Bus in **8E1**. Eine reine TCP-Bridge mit festem Format kann das nicht (das Paritätsbit liegt dort, wo der Zähler das Stoppbit erwartet). Die ESPHome-Konfiguration in [`esphome/wmz-bridge.yaml`](esphome/wmz-bridge.yaml) bietet deshalb eine Auswahl, die der Adapter über den ESPHome-Webserver umschaltet:

1. Auswahl → `8N1`, 2,2 s `0x55` senden, warten bis gesendet
2. Auswahl → `8E1`, Application Reset `68 04 04 68 53 FE 50 00 A1 16` (der UltraLite PRO antwortet nur danach)
3. `REQ_UD2` (`10 5B FE 59 16`), Long Frame empfangen und dekodieren

## Unterstützte Modelle

| Modell                                                    | Status   |
| --------------------------------------------------------- | -------- |
| Allmess Integral-V UltraLite PRO (optische Schnittstelle) | getestet |

Die Datensätze werden über ihre Bedeutung (VIF) zugeordnet, nicht über feste Bytes. Andere Skalierungen (z. B. Energie in MWh) werden so richtig umgerechnet. Weitere Zähler lassen sich als Datei unter `lib/models/` ergänzen.

## ESP-Bridge

- [`esphome/wmz-bridge.yaml`](esphome/wmz-bridge.yaml) flashen (M5Stack Unit PoE P4; für andere Boards Pins/Netzwerk anpassen). Die `stream_server`-Komponente wird als lokale Kopie in `components/stream_server` neben der YAML erwartet (derselbe Ordner wie bei der Modbus-Bridge).
- IR-Kopf (TTL, 3,3 V): ESP-TX `GPIO17` → Eingang des Kopfs, ESP-RX `GPIO16` ← Ausgang des Kopfs.
- Ab ESPHome 2026.1 enthalten REST-URLs den Entitätsnamen, ältere Versionen die Objekt-ID – der Adapter kann beides.
- Hat der ESP-Webserver Benutzer/Passwort (Basic Auth), lässt sich das im Adapter eintragen.

## Datenpunkte

| Datenpunkt                                                        | Inhalt                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Energie`, `Volumen`                                              | Zählerstände (kWh, m³)                                                                            |
| `Leistung`, `Durchfluss`, `Vorlauf`, `Ruecklauf`, `Spreizung`     | Wärmeleistung (kW), Durchfluss (l/h), Vor-/Rücklauf (°C), Differenz (K)                           |
| `Betriebszeit`, `Zaehlerzeit`                                     | Betriebstage, Uhr im Zähler                                                                       |
| `Verbrauch.Waerme_*`                                              | Wärme heute/gestern, Monat/Vormonat, Jahr/Vorjahr (kWh)                                           |
| `Geraet.*`                                                        | Fabrikations-/Identnummer, Hersteller, Medium, Firmware/Software, Status, Zugriffszähler          |
| `info.*`                                                          | Verbindung, letzte (erfolgreiche) Abfrage, Fehler, Zähler, aktuelles Intervall, letztes Telegramm |
| `control.auslesen`, `control.messphase`, `control.schnellabfrage` | jetzt auslesen; Messphase; Schnellabfrage anfordern                                               |

Messwerte werden bei jeder Abfrage geschrieben, der Zeitstempel zeigt also die letzte Ablesung.

## Überwachung der Bridge

Der Adapter prüft die Bridge alle 30 s über ihren Webserver; der Zähler wird dabei nicht geweckt. `info.connection` ist nur `true`, wenn die TCP-Verbindung steht **und** der Webserver antwortet. Ein stromloser oder hängender ESP fällt so in etwa einer Minute auf. Der Adapter schreibt dann einmal eine Warnung ins Log, setzt `info.offlineSince` (Zeitpunkt) und `info.offlineReason` und meldet sich mit einer Info, sobald die Bridge wieder erreichbar ist. Solange die Bridge erreichbar ist, ist `info.offlineSince` leer – ein guter Auslöser für eine Benachrichtigung (z. B. Telegram).

## Abfrage und Batterie

Jede Abfrage weckt den Zähler und kostet Batterie. Meist gilt das **normale Intervall** (Standard 30 min). Das **schnelle Intervall** (Standard 60 s) gilt nur, solange die **Messphase** `control.messphase` freigegeben ist **und** eine Schnellabfrage angefordert wird – per `control.schnellabfrage` (z. B. aus Node-RED) oder über einen optionalen Auslöser-Datenpunkt in den Instanzeinstellungen (z. B. Verdichter-Status der Wärmepumpe; true oder > 0 = aktiv).

Der Status im Telegrammkopf wird ausgewertet; „Batterie schwach“ erscheint zusätzlich als Warnung im Log.

## Umzug von der MQTT-Lösung

[`tools/migration_von_mqtt.js`](tools/migration_von_mqtt.js) (ioBroker-JavaScript-Skript) überträgt die InfluxDB-Einstellungen samt Alias von `mqtt.0.mbus-meter.sensor.*` auf die neuen Datenpunkte. Aliasse, deren alte Werte als Text gespeichert sind, übernimmt es nicht, weil InfluxDB den Feldtyp beibehält. Zuerst mit `DRY_RUN = true` starten.

## Fehlersuche

Auf Log-Stufe **debug** wird jede Abfrage protokolliert (Aufwecken, Umschalten, `E5`-Quittung, Antwortgröße und -zeit). Mit _Jedes Telegramm ins Log schreiben_ erscheint jedes Telegramm im Log; das letzte steht immer in `info.rawFrame` und lässt sich mit jedem M-Bus-Decoder prüfen. Datensätze ohne Zuordnung werden einmal gemeldet, mit _Datenpunkte für unbekannte Datensätze anlegen_ erscheinen sie unter `Weitere`.

Keine Antwort: Sitz des Lesekopfs prüfen (die IR-LED muss beim Aufwecken ca. 2 s flackern – mit einer Handykamera sichtbar) und den Namen der Auswahl.

## Installation

```bash
iob url https://github.com/MMeinhardt1/ioBroker.allmess-mbus
iob add allmess-mbus
```
