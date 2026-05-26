let isInitialized = false;
let defaultEnvironmentName = "default";
let defaultStoragePath: string | undefined = undefined;
let defaultConfigFilePath = "config.json";
let loadProcessArgv = true;
let loadProcessEnv = true;
let loadConfigFile = true;
let initializeStorage = true;
let trapProcessSignals = true;
let trapUnhandledErrors = true;
let setProcessExitCodeOnError = true;
let installFilesystem = true;
let installNetwork = true;
let installCrypto = true;
let storageDriver = "file";

export class TxikiJsAlreadyInitializedError extends Error {}

export const config = {
    set isInitialized(value: boolean) {
        if (value) {
            isInitialized = true;
        }
    },

    get defaultEnvironmentName() {
        return defaultEnvironmentName;
    },

    set defaultEnvironmentName(value: string) {
        assertUninitialized("defaultEnvironmentName");
        defaultEnvironmentName = value;
    },

    get defaultStoragePath() {
        return defaultStoragePath;
    },

    set defaultStoragePath(value: string | undefined) {
        assertUninitialized("defaultStoragePath");
        defaultStoragePath = value;
    },

    get defaultConfigFilePath() {
        return defaultConfigFilePath;
    },

    set defaultConfigFilePath(value: string) {
        assertUninitialized("defaultConfigFilePath");
        defaultConfigFilePath = value;
    },

    get loadProcessArgv() {
        return loadProcessArgv;
    },

    set loadProcessArgv(value: boolean) {
        assertUninitialized("parseProcessArgv");
        loadProcessArgv = value;
    },

    get loadProcessEnv() {
        return loadProcessEnv;
    },

    set loadProcessEnv(value: boolean) {
        assertUninitialized("loadProcessEnv");
        loadProcessEnv = value;
    },

    get loadConfigFile() {
        return loadConfigFile;
    },

    set loadConfigFile(value: boolean) {
        assertUninitialized("loadConfigFile");
        loadConfigFile = value;
    },

    get installCrypto() {
        return installCrypto;
    },

    set installCrypto(value: boolean) {
        assertUninitialized("installCrypto");
        installCrypto = value;
    },

    get installFilesystem() {
        return installFilesystem;
    },

    set installFilesystem(value: boolean) {
        assertUninitialized("installFilesystem");
        installFilesystem = value;
    },

    get installNetwork() {
        return installNetwork;
    },

    set installNetwork(value: boolean) {
        assertUninitialized("installNetwork");
        installNetwork = value;
    },

    get initializeStorage() {
        return initializeStorage;
    },

    set initializeStorage(value: boolean) {
        assertUninitialized("initializeStorage");
        initializeStorage = value;
    },

    get storageDriver() {
        return storageDriver;
    },

    set storageDriver(value: string) {
        assertUninitialized("initializeStorage");
        storageDriver = value;
    },

    get trapProcessSignals() {
        return trapProcessSignals;
    },

    set trapProcessSignals(value: boolean) {
        assertUninitialized("trapProcessSignals");
        trapProcessSignals = value;
    },

    get trapUnhandledErrors() {
        return trapUnhandledErrors;
    },

    set trapUnhandledErrors(value: boolean) {
        assertUninitialized("trapUnhandledErrors");
        trapUnhandledErrors = value;
    },

    get setProcessExitCodeOnError() {
        return setProcessExitCodeOnError;
    },

    set setProcessExitCodeOnError(value: boolean) {
        assertUninitialized("setProcessExit");
        setProcessExitCodeOnError = value;
    },
};

function assertUninitialized(name: string) {
    if (isInitialized) {
        throw new TxikiJsAlreadyInitializedError(
            `Cannot set config property "${name}" because txiki.js environment is already initialized`,
        );
    }
}
