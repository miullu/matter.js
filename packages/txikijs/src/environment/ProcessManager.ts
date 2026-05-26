import { Destructable, Environment, Logger, RuntimeService } from "@matter/general";

export class ProcessManager implements Destructable {
    protected runtime: RuntimeService;
    #signalHandlersInstalled = false;

    constructor(protected env: Environment) {
        this.runtime = env.get(RuntimeService);

        this.runtime.started.on(this.startListener);
        this.runtime.stopped.on(this.stopListener);
        this.runtime.crashed.on(this.crashListener);

        if (this.hasUnhandledErrorSupport) {
            this.setupUnhandledErrorCapture();
        }
    }

    protected setupUnhandledErrorCapture() {
        globalThis.addEventListener?.("error", (event: Event) => {
            Logger.reportUnhandledError(event as unknown as Error);
        });
        globalThis.addEventListener?.("unhandledrejection", (event: PromiseRejectionEvent) => {
            Logger.reportUnhandledError(event.reason);
        });
    }

    close() {
        this.runtime.started.off(this.startListener);
        this.runtime.stopped.off(this.stopListener);
        this.runtime.crashed.off(this.crashListener);
        this.#ignoreSignals();
    }

    [Symbol.dispose]() {
        this.close();
    }

    protected get hasSignalSupport() {
        return this.env.vars.get("runtime.signals", true);
    }

    protected get hasExitCodeSupport() {
        return this.env.vars.get("runtime.exitcode", true);
    }

    protected get hasUnhandledErrorSupport() {
        return this.env.vars.get("runtime.unhandlederrors", true);
    }

    protected startListener = () => {
        this.env.vars.use(() => {
            if (this.hasSignalSupport) {
                if (this.#signalHandlersInstalled) {
                    return;
                }

                this.installInterruptHandlers();
                this.#signalHandlersInstalled = true;
            } else {
                this.#ignoreSignals();
            }
        });
    };

    protected stopListener = () => {
        this.#ignoreSignals();
    };

    protected crashListener = () => {
        if (this.hasExitCodeSupport) {
            try {
                tjs.exit(1);
            } catch {}
        }
    };

    protected interruptHandler = () => {
        this.uninstallInterruptHandlers();
        this.installInterruptHandlers();
        this.runtime.interrupt();
    };

    protected diagnosticHandler = () => {
        this.env.diagnose();
    };

    protected installInterruptHandlers = () => {
        try {
            tjs.addSignalListener("SIGINT", this.interruptHandler);
            tjs.addSignalListener("SIGTERM", this.interruptHandler);
        } catch {}
    };

    protected uninstallInterruptHandlers = () => {
        try {
            tjs.removeSignalListener("SIGINT", this.interruptHandler);
            tjs.removeSignalListener("SIGTERM", this.interruptHandler);
        } catch {}
    };

    #ignoreSignals() {
        if (this.#signalHandlersInstalled) {
            this.uninstallInterruptHandlers();
            this.#signalHandlersInstalled = false;
        }
    }
}
