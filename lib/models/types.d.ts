// Typen fuer Telegramme und Modell-Definitionen (nur fuer den Typecheck, keine Laufzeitwirkung)

export interface MbusHeader {
    /** Identnummer (BCD, 8 Stellen) */
    id: string;
    /** Herstellerkennung, 3 Buchstaben */
    manufacturer: string;
    version: number;
    medium: number;
    mediumText: string;
    /** Zugriffszaehler */
    access: number;
    status: number;
    statusText: string;
    signature: number;
}

export interface MbusRecord {
    /** DIF(+DIFE) VIF(+VIFE) als Hex, z. B. "0406" */
    key: string;
    /** kompletter Datensatz als Hex */
    raw: string;
    dif: number;
    vif: number;
    vife: number[];
    storage: number;
    tariff: number;
    subunit: number;
    func: 'inst' | 'max' | 'min' | 'error';
    /** Bedeutung laut VIF, z. B. "energy", "volume", "flowTemperature" */
    quantity: string;
    /** Basiseinheit laut VIF, z. B. "Wh", "m³", "W", "m³/h", "°C" */
    unit: string;
    value: number | string | null;
    /** Zeitpunkt in ms (nur Datum/Uhrzeit) */
    time?: number;
}

export interface MbusTelegram {
    c: number;
    address: number;
    ci: number;
    header: MbusHeader | null;
    records: MbusRecord[];
    manufacturerData?: Buffer;
}

export interface ValueDef {
    /** Bedeutung laut VIF (siehe MbusRecord.quantity) */
    quantity: string;
    /** Speichernummer (0 = aktueller Wert), Standard 0 */
    storage?: number;
    /** Tarif, Standard 0 */
    tariff?: number;
    /** Funktion, Standard "inst" */
    func?: MbusRecord['func'];
    /** Ziel-Datenpunkt (relativ zur Instanz) */
    state: string;
    name: string;
    role: string;
    /** Zieleinheit (wird aus der Basiseinheit umgerechnet) */
    unit?: string;
    /** Datentyp im Datenpunkt; "time" = Zeitpunkt in ms */
    type?: 'number' | 'string' | 'time';
    /** Nachkommastellen (Rundung nach der Umrechnung) */
    decimals?: number;
    /** Zaehlerstand fuer die Tages-/Monats-/Jahreswerte */
    counter?: boolean;
}

export interface ModelDef {
    id: string;
    label: string;
    manufacturer: string;
    /** Application Reset vor REQ_UD2 senden (manche Zaehler liefern sonst keine Daten) */
    appReset: boolean;
    values: ValueDef[];
    /** bekannte Datensaetze, die bewusst nicht ausgegeben werden (keine "unbekannt"-Meldung) */
    ignore?: { quantity: string; storage?: number }[];
}
