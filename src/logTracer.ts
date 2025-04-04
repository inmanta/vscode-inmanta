import * as util from 'util';
import { Disposable, LogOutputChannel } from 'vscode';

type Arguments = unknown[];

/**
 * A logger that writes messages to a VS Code output channel.
 */
class OutputChannelLogger {
    /**
     * Creates an instance of OutputChannelLogger.
     * @param channel The VS Code output channel to write logs to.
     */
    constructor(private readonly channel: LogOutputChannel) { }

    /**
     * Logs a trace message.
     * @param data The data to log.
     */
    public traceLog(...data: Arguments): void {
        this.channel.appendLine(util.format(...data));
    }

    /**
     * Logs an error message.
     * @param data The data to log.
     */
    public traceError(...data: Arguments): void {
        this.channel.error(util.format(...data));
    }

    /**
     * Logs a warning message.
     * @param data The data to log.
     */
    public traceWarn(...data: Arguments): void {
        this.channel.warn(util.format(...data));
    }

    /**
     * Logs an informational message.
     * @param data The data to log.
     */
    public traceInfo(...data: Arguments): void {
        this.channel.info(util.format(...data));
    }

    /**
     * Logs a verbose message.
     * @param data The data to log.
     */
    public traceVerbose(...data: Arguments): void {
        this.channel.debug(util.format(...data));
    }

    /**
     * Logs a map.
     * @param map The map to log.
     * @param msg The message to log before the map.
     */
    public traceMap(map: Map<string, unknown>, msg: string): void {
        this.channel.appendLine(`${msg} {`);
        for (const [key, value] of map.entries()) {
            this.channel.appendLine(`  ${key}: ${util.format(value)}`);
        }
        this.channel.appendLine(`}`);
    }
}

let channel: OutputChannelLogger | undefined;

/**
 * Registers a logger to a VS Code output channel.
 * @param logChannel The VS Code output channel to write logs to.
 * @returns A Disposable to unregister the logger.
 */
export function registerLogger(logChannel: LogOutputChannel): Disposable {
    channel = new OutputChannelLogger(logChannel);
    return {
        dispose: () => {
            channel = undefined;
        },
    };
}

/**
 * Logs a trace message.
 * @param args The data to log.
 */
export function traceLog(...args: Arguments): void {
    channel?.traceLog(...args);
}

/**
 * Logs an error message.
 * @param args The data to log.
 */
export function traceError(...args: Arguments): void {
    channel?.traceError(...args);
}

/**
 * Logs a warning message.
 * @param args The data to log.
 */
export function traceWarn(...args: Arguments): void {
    channel?.traceWarn(...args);
}

/**
 * Logs an informational message.
 * @param args The data to log.
 */
export function traceInfo(...args: Arguments): void {
    channel?.traceInfo(...args);
}

/**
 * Logs a verbose message.
 * @param args The data to log.
 */
export function traceVerbose(...args: Arguments): void {
    channel?.traceVerbose(...args);
}

/**
 * Logs a map.
 * @param map The map to log.
 */
export function traceMap(map: Map<string, unknown>, msg: string): void {
    channel?.traceMap(map, msg);
}