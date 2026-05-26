import { config } from "#config.js";
import {
    Boot,
    Crypto,
    Entropy,
    Environment,
    FileHandleTracker,
    Filesystem,
    LogFormat,
    Logger,
    MemoryStorageDriver,
    Network,
    ServiceBundle,
    StandardCrypto,
    StorageService,
    VariableService,
} from "@matter/general";

import { TxikiJsFilesystem } from "../fs/TxikiJsFilesystem.js";
import { TxikiJsNetwork } from "../net/TxikiJsNetwork.js";
import { ProcessManager } from "./ProcessManager.js";

export function TxikiJsEnvironment() {
    const env = new Environment("default");

    loadVariables(env);
    configureCrypto(env);
    configureRuntime(env);
    configureStorage(env);
    configureNetwork(env);
    configureFilesystem(env);

    if (!env.vars.has("logger.format") && Logger.format === LogFormat.PLAIN && tjs.stdin?.isTerminal) {
        env.vars.set("logger.format", LogFormat.ANSI);
    }

    ServiceBundle.default.deploy(env);

    config.isInitialized = true;

    return env;
}

function loadVariables(env: Environment) {
    const vars = env.vars;

    vars.addConfigStyle(getDefaults(vars));

    if (config.loadProcessEnv) {
        vars.addUnixEnvStyle(tjs.env);
    }
    if (config.loadProcessArgv) {
        vars.addArgvStyle([...tjs.args]);
    }

    const { configVars } = getConfigVars(vars);
    if (config.loadConfigFile) {
        vars.addConfigStyle(configVars as Record<string, VariableService.Value>);
    }

    if (config.loadProcessEnv) {
        vars.addUnixEnvStyle(tjs.env);
    }
    if (config.loadProcessArgv) {
        vars.addArgvStyle([...tjs.args]);
    }

    const configVarsRecord = configVars as Record<string, VariableService.Value>;
    vars.persistConfigValue = async (name: string, value: VariableService.Value) => {
        if (value === undefined) {
            delete configVarsRecord[name];
        }
        configVarsRecord[name] = value;
        const configPath = vars.get("path.config", "config.json");
        await tjs.writeFile(configPath, JSON.stringify(configVars, undefined, 4));
    };
}

function rootDirOf(env: Environment) {
    return env.vars.get("path.root", ".");
}

function configureCrypto(env: Environment) {
    Boot.init(() => {
        if (env.vars.boolean("txikijs.crypto")) {
            const crypto = new StandardCrypto(globalThis.crypto);
            env.set(Entropy, crypto);
            env.set(Crypto, crypto);
            return;
        }
        if (Environment.default.has(Entropy)) {
            env.set(Entropy, Environment.default.get(Entropy));
        }
        if (Environment.default.has(Crypto)) {
            env.set(Crypto, Environment.default.get(Crypto));
        }
    });
}

function configureNetwork(env: Environment) {
    Boot.init(() => {
        if (env.vars.boolean("txikijs.network")) {
            env.set(Network, new TxikiJsNetwork());
            return;
        }
        if (Environment.default.has(Network)) {
            env.set(Network, Environment.default.get(Network));
        }
    });
}

function configureRuntime(env: Environment) {
    const processManager = new ProcessManager(env);
    env.set(ProcessManager, processManager);
}

function configureStorage(env: Environment) {
    Boot.init(() => {
        if (env.vars.boolean("txikijs.storage")) {
            const service = env.get(StorageService);

            service.registerDriver(MemoryStorageDriver);

            void import("#storage/fs/FileStorageDriver.js").then(({ FileStorageDriver }) => {
                service.registerDriver({
                    id: FileStorageDriver.id,
                    create: (namespace, descriptor) => FileStorageDriver.create(namespace, descriptor),
                });
            });

            void import("#storage/sqlite/index.js").then(({ SqliteStorageDriver }) => {
                service.registerDriver({
                    id: SqliteStorageDriver.id,
                    create: (namespace, descriptor) => SqliteStorageDriver.create(namespace, descriptor),
                });
            });

            const storageDriver = env.vars.string("storage.driver");
            if (storageDriver && storageDriver.length > 0) {
                service.configuredDriver = storageDriver;
            }

            return;
        }
        if (Environment.default.has(StorageService)) {
            env.set(StorageService, Environment.default.get(StorageService));
        }
    });
}

function configureFilesystem(env: Environment) {
    FileHandleTracker.onExit(callback => {
        try {
            tjs.addSignalListener("SIGINT", callback);
        } catch {}
    });

    Boot.init(() => {
        if (env.vars.boolean("txikijs.filesystem")) {
            env.set(Filesystem, new TxikiJsFilesystem(() => env.vars.get("storage.path", rootDirOf(env))));
            return;
        }
        if (Environment.default.has(Filesystem)) {
            env.set(Filesystem, Environment.default.get(Filesystem));
        }
    });
}

export function getConfigVars(_vars: VariableService) {
    return { configVars: {} };
}

function getDefaultRoot(envName: string) {
    if (config.defaultStoragePath !== undefined) {
        return config.defaultStoragePath;
    }
    let matterDir = `${tjs.homeDir || "."}/.matter`;

    if (envName !== "default") {
        matterDir = `${matterDir}-${envName}`;
    }

    return matterDir;
}

export function getDefaults(vars: VariableService) {
    const envName = vars.get("environment", config.defaultEnvironmentName);
    const rootPath = vars.get("path.root", getDefaultRoot(envName));

    return {
        environment: envName,
        path: {
            root: rootPath,
        },
        runtime: {
            signals: config.trapProcessSignals,
            exitcode: config.setProcessExitCodeOnError,
            unhandlederrors: config.trapUnhandledErrors,
        },
        txikijs: {
            crypto: config.installCrypto,
            filesystem: config.installFilesystem,
            network: config.installNetwork,
            storage: config.initializeStorage,
        },
        storage: {
            driver: config.storageDriver,
        },
    };
}
