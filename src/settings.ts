// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { ConfigurationChangeEvent, ConfigurationScope, WorkspaceConfiguration, WorkspaceFolder } from 'vscode';
import { getInterpreterDetails } from './python';
import { getConfiguration, getWorkspaceFolders } from './vscode_api';

export interface ISettings {
    cwd: string;
    workspace: string;
    args: string[];
    path: string[];
    interpreter: string[];
    importStrategy: string;
    showNotifications: string;
}

/**
 * Retrieves the extension settings for all workspace folders.
 * 
 * @param namespace - The namespace of the settings.
 * @param includeInterpreter - Whether to include interpreter settings.
 * @returns A promise that resolves to an array of settings for each workspace folder.
 */
export function getExtensionSettings(namespace: string, includeInterpreter?: boolean): Promise<ISettings[]> {
    return Promise.all(getWorkspaceFolders().map((w) => getWorkspaceSettings(namespace, w, includeInterpreter)));
}

/**
 * Resolves variables in the given array of strings based on the workspace and environment.
 * 
 * @param value - The array of strings containing variables to resolve.
 * @param workspace - The workspace folder to use for resolving variables.
 * @returns The array of strings with resolved variables.
 */
function resolveVariables(value: string[], workspace?: WorkspaceFolder): string[] {
    const substitutions = new Map<string, string>();
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
        substitutions.set('${userHome}', home);
    }
    if (workspace) {
        substitutions.set('${workspaceFolder}', workspace.uri.fsPath);
    }
    substitutions.set('${cwd}', process.cwd());
    getWorkspaceFolders().forEach((w) => {
        substitutions.set('${workspaceFolder:' + w.name + '}', w.uri.fsPath);
    });

    return value.map((s) => {
        for (const [key, value] of substitutions) {
            s = s.replace(key, value);
        }
        return s;
    });
}

/**
 * Retrieves the interpreter settings from the configuration.
 * 
 * @param namespace - The namespace of the settings.
 * @param scope - The scope of the configuration.
 * @returns The interpreter settings as an array of strings.
 */
export function getInterpreterFromSetting(namespace: string, scope?: ConfigurationScope) {
    const config = getConfiguration(namespace, scope);
    return config.get<string[]>('interpreter');
}

/**
 * Retrieves the settings for a specific workspace folder.
 * 
 * @param namespace - The namespace of the settings.
 * @param workspace - The workspace folder to retrieve settings for.
 * @param includeInterpreter - Whether to include interpreter settings.
 * @returns A promise that resolves to the settings for the workspace folder.
 */
export async function getWorkspaceSettings(
    namespace: string,
    workspace: WorkspaceFolder,
    includeInterpreter?: boolean,
): Promise<ISettings> {
    const config = getConfiguration(namespace, workspace.uri);

    let interpreter: string[] = [];
    if (includeInterpreter) {
        interpreter = getInterpreterFromSetting(namespace, workspace) ?? [];
        if (interpreter.length === 0) {
            interpreter = (await getInterpreterDetails(workspace.uri)).path ?? [];
        }
    }

    const workspaceSetting = {
        cwd: workspace.uri.fsPath,
        workspace: workspace.uri.toString(),
        args: resolveVariables(config.get<string[]>(`args`) ?? [], workspace),
        path: resolveVariables(config.get<string[]>(`path`) ?? [], workspace),
        interpreter: resolveVariables(interpreter, workspace),
        importStrategy: config.get<string>(`importStrategy`) ?? 'useBundled',
        showNotifications: config.get<string>(`showNotifications`) ?? 'off',
    };
    return workspaceSetting;
}

/**
 * Retrieves a global configuration value.
 * 
 * @param config - The workspace configuration.
 * @param key - The key of the configuration value.
 * @param defaultValue - The default value to return if the configuration value is not set.
 * @returns The global configuration value.
 */
function getGlobalValue<T>(config: WorkspaceConfiguration, key: string, defaultValue: T): T {
    const inspect = config.inspect<T>(key);
    return inspect?.globalValue ?? inspect?.defaultValue ?? defaultValue;
}

/**
 * Retrieves the global settings for the extension.
 * 
 * @param namespace - The namespace of the settings.
 * @param includeInterpreter - Whether to include interpreter settings.
 * @returns A promise that resolves to the global settings.
 */
export async function getGlobalSettings(namespace: string, includeInterpreter?: boolean): Promise<ISettings> {
    const config = getConfiguration(namespace);

    let interpreter: string[] = [];
    if (includeInterpreter) {
        interpreter = getGlobalValue<string[]>(config, 'interpreter', []);
        if (interpreter === undefined || interpreter.length === 0) {
            interpreter = (await getInterpreterDetails()).path ?? [];
        }
    }

    const setting = {
        cwd: process.cwd(),
        workspace: process.cwd(),
        args: getGlobalValue<string[]>(config, 'args', []),
        path: getGlobalValue<string[]>(config, 'path', []),
        interpreter: interpreter,
        importStrategy: getGlobalValue<string>(config, 'importStrategy', 'useBundled'),
        showNotifications: getGlobalValue<string>(config, 'showNotifications', 'off'),
    };
    return setting;
}

/**
 * Checks if the configuration has changed for the given namespace.
 * 
 * @param e - The configuration change event.
 * @param namespace - The namespace of the settings.
 * @returns True if the configuration has changed, false otherwise.
 */
export function checkIfConfigurationChanged(e: ConfigurationChangeEvent, namespace: string): boolean {
    const settings = [
        `${namespace}.args`,
        `${namespace}.path`,
        `${namespace}.interpreter`,
        `${namespace}.importStrategy`,
        `${namespace}.showNotifications`,
    ];
    const changed = settings.map((s) => e.affectsConfiguration(s));
    return changed.includes(true);
}