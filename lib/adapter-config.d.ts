// Erweitert den AdapterConfig-Typ um die native-Konfiguration aus io-package.json (nur fuer den Typecheck).

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace ioBroker {
        interface AdapterConfig {
            model: string;
            host: string;
            tcpPort: number;
            httpPort: number;
            selectName: string;
            httpUser: string;
            httpPassword: string;
            intervalNormal: number;
            intervalFast: number;
            fastTriggerState: string;
            wakeupMs: number;
            pauseMs: number;
            responseTimeoutMs: number;
            appReset: boolean;
            logRawFrames: boolean;
            createUnknownRecords: boolean;
        }
    }
}

export {};
