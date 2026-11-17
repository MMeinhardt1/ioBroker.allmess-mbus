![Logo](admin/allmess-mbus.png)

# ioBroker.allmess-mbus

**[Deutsche Version](README.de.md)**

ioBroker adapter for Allmess heat meters (Integral-V UltraLite PRO, also sold as "comfort by Sanibal") via the **optical M-Bus interface**. An ESP32 running ESPHome acts as a bridge to the IR read/write head; the adapter does everything else: waking the meter, requesting and decoding the data, intervals and data points.

## How it works

```
Meter ⟿ IR ⟿ TTL read/write head ── UART ── ESP32 (ESPHome)  ──── LAN ──── ioBroker (allmess-mbus)
                                              • stream_server (TCP, 2400 baud)
                                              • select "UART Format" 8N1/8E1 (REST)
```

The meter only wakes up on `0x55` sent in **8N1** for about 2.2 s, but talks M-Bus in **8E1** afterwards. A plain TCP bridge with a fixed format cannot do that (the parity bit lands where the meter expects the stop bit). The ESPHome configuration in [`esphome/wmz-bridge.yaml`](esphome/wmz-bridge.yaml) therefore offers a select that the adapter switches via the ESPHome web server:

1. select → `8N1`, send `0x55` for 2.2 s, wait until sent
2. select → `8E1`, application reset `68 04 04 68 53 FE 50 00 A1 16` (the UltraLite PRO only answers after it)
3. `REQ_UD2` (`10 5B FE 59 16`), receive and decode the long frame

## Supported models

| Model                                           | Status |
| ----------------------------------------------- | ------ |
| Allmess Integral-V UltraLite PRO (optical port) | tested |

Records are assigned by their meaning (VIF), not by fixed bytes, so different scalings (e.g. energy in MWh) are converted correctly. Further meters can be added as a file in `lib/models/`.

## ESP bridge

- Flash [`esphome/wmz-bridge.yaml`](esphome/wmz-bridge.yaml) (M5Stack Unit PoE P4; adapt pins/network for other boards). It expects the `stream_server` component as a local copy in `components/stream_server` next to the YAML (same folder as for the Modbus bridge).
- IR head (TTL, 3.3 V): ESP TX `GPIO17` → head input, ESP RX `GPIO16` ← head output.
- ESPHome ≥ 2026.1 uses entity names in REST URLs; older versions use object IDs – the adapter handles both.
- A web server user/password (basic auth) can be configured in the adapter if the ESP uses one.

## Data points

| Data point                                                        | Content                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Energie`, `Volumen`                                              | meter readings (kWh, m³)                                                                  |
| `Leistung`, `Durchfluss`, `Vorlauf`, `Ruecklauf`, `Spreizung`     | heat power (kW), flow (l/h), flow/return temperature (°C), difference (K)                 |
| `Betriebszeit`, `Zaehlerzeit`                                     | operating days, meter clock                                                               |
| `Verbrauch.Waerme_*`                                              | heat today/yesterday, month/previous month, year/previous year (kWh)                      |
| `Geraet.*`                                                        | fabrication/ident number, manufacturer, medium, firmware/software, status, access counter |
| `info.*`                                                          | connection, last (successful) read, error, counters, current interval, last raw telegram  |
| `control.auslesen`, `control.messphase`, `control.schnellabfrage` | read now; measurement phase; request fast polling                                         |

Data point names are in German. Measured values are written on every read, so the timestamp shows the time of the last reading.

## Bridge monitoring

The adapter checks the bridge every 30 s via its web server; this does not wake the meter. `info.connection` is only `true` if the TCP connection is up **and** the web server answers. A powered-off or hung ESP is detected within about a minute. The adapter then logs one warning, sets `info.offlineSince` (timestamp) and `info.offlineReason`, and logs an info message once the bridge is back. `info.offlineSince` is empty while the bridge is reachable – a good trigger for a notification (e.g. Telegram).

## Polling and battery

Every read-out wakes the meter and costs battery. The **normal interval** (default 30 min) applies most of the time. The **fast interval** (default 60 s) is only used while the **measurement phase** `control.messphase` is enabled **and** fast polling is requested – either by `control.schnellabfrage` (e.g. from Node-RED) or by an optional trigger state in the instance settings (e.g. the heat pump's compressor state; true or > 0 = active).

The header status is decoded; "Batterie schwach" (battery low) is also logged as a warning.

## Migration from the MQTT solution

[`tools/migration_von_mqtt.js`](tools/migration_von_mqtt.js) (ioBroker JavaScript script) moves the InfluxDB settings including aliases from `mqtt.0.mbus-meter.sensor.*` to the new data points. It refuses aliases whose old values were stored as text, because InfluxDB keeps the field type. Run it with `DRY_RUN = true` first.

## Troubleshooting

At log level **debug** every read is traced (wake-up, format switch, `E5` acknowledgement, response size and time). With _Log every telegram_ each telegram is written to the log; the last one is always in `info.rawFrame` and can be checked with any M-Bus decoder. Records without assignment are logged once; with _Create states for unknown records_ they appear under `Weitere`.

If there is no answer: check the position of the head (the IR LED must flicker for about 2 s during wake-up – visible with a phone camera) and the select name.

## Installation

```bash
iob url https://github.com/MMeinhardt1/ioBroker.allmess-mbus
iob add allmess-mbus
```

## Changelog

### 0.1.2 (2026-11-17)

- Bridge monitoring: heartbeat every 30 s via the ESPHome web server (does not wake the meter); `info.connection` is only true if TCP **and** the web server respond
- A powered-off or hung ESP is detected within about a minute (previously only via TCP keepalive after ~10 min); the TCP connection is then closed and rebuilt
- New states `info.offlineSince` and `info.offlineReason`; one warning when the bridge goes offline, one info message when it is back

### 0.1.1 (2026-11-17)

- ESPHome bridge configuration (`esphome/wmz-bridge.yaml`) uses a local copy of the `stream_server` component (`components/stream_server` next to the YAML) instead of fetching it from GitHub on every build

### 0.1.0 (2026-11-17)

- Initial release: Allmess Integral-V UltraLite PRO via the optical M-Bus interface and an ESPHome bridge (stream_server + switchable UART format)
- Generic M-Bus long-frame decoder (VIF-based), application reset, decoding of header status
- Heat per day/month/year, measurement phase with fast polling (state or trigger state)
- ESPHome configuration for the bridge and migration script from the previous MQTT solution

## License

MIT License

Copyright (c) 2026 MMeinhardt1

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
