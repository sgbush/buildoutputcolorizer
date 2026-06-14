import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parse as parseJsonc } from 'jsonc-parser';

// The 5 TextMate scopes this extension controls.
const LOG_SCOPES = [
    'markup.other.log.error',
    'markup.other.log.warn',
    'markup.other.log.info',
    'markup.other.log.debug',
    'markup.other.log.highlight',
] as const;

type LogScope = typeof LOG_SCOPES[number];

const SCOPE_TO_SETTING: Record<LogScope, string> = {
    'markup.other.log.error':     'buildOutputColorizer.errorColorKey',
    'markup.other.log.warn':      'buildOutputColorizer.warnColorKey',
    'markup.other.log.info':      'buildOutputColorizer.infoColorKey',
    'markup.other.log.debug':     'buildOutputColorizer.debugColorKey',
    'markup.other.log.highlight': 'buildOutputColorizer.highlightColorKey',
};

interface TextMateRule {
    scope: string;
    settings: { foreground?: string };
}

let out: vscode.OutputChannel | undefined;

function log(msg: string): void {
    if (!out) { return; }
    const ts = new Date().toISOString();
    out.appendLine(`[${ts}] ${msg}`);
}

function logError(err: unknown): void {
    log(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
}

export function activate(context: vscode.ExtensionContext): void {
    const cfg = vscode.workspace.getConfiguration('buildOutputColorizer');

    if (cfg.get<boolean>('enableDiagnosticLogging') === true) {
        out = vscode.window.createOutputChannel('Build Output Colorizer');
        context.subscriptions.push(out);
    }

    log('Extension activated.');

    const enabled = cfg.get<boolean>('useTerminalColors') === true;
    log(`useTerminalColors on startup: ${enabled}`);

    if (enabled) {
        applyThemeColors().catch(logError);
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            const relevant = [
                'buildOutputColorizer.enableDiagnosticLogging',
                'buildOutputColorizer.useTerminalColors',
                'workbench.colorTheme',
                ...Object.values(SCOPE_TO_SETTING),
            ];
            if (!relevant.some((key) => e.affectsConfiguration(key))) {
                return;
            }
            const nowEnabled = vscode.workspace
                .getConfiguration('buildOutputColorizer')
                .get<boolean>('useTerminalColors');

            if (e.affectsConfiguration('buildOutputColorizer.enableDiagnosticLogging')) {
                const loggingEnabled = vscode.workspace
                    .getConfiguration('buildOutputColorizer')
                    .get<boolean>('enableDiagnosticLogging');
                if (loggingEnabled && !out) {
                    out = vscode.window.createOutputChannel('Build Output Colorizer');
                    context.subscriptions.push(out);
                    log('Diagnostic logging enabled.');
                } else if (!loggingEnabled && out) {
                    log('Diagnostic logging disabled.');
                    out.dispose();
                    out = undefined;
                }
                return;
            }
            if (e.affectsConfiguration('workbench.colorTheme')) {
                const themeName = vscode.workspace
                    .getConfiguration('workbench')
                    .get<string>('colorTheme', '');
                log(`workbench.colorTheme changed to: "${themeName}". useTerminalColors=${nowEnabled}`);
            } else if (e.affectsConfiguration('buildOutputColorizer.useTerminalColors')) {
                log(`useTerminalColors changed to: ${nowEnabled}`);
            } else {
                log(`Color key setting changed. useTerminalColors=${nowEnabled}`);
            }

            if (nowEnabled) {
                applyThemeColors().catch(logError);
            } else if (e.affectsConfiguration('buildOutputColorizer.useTerminalColors')) {
                log('Feature disabled — resetting token color customizations.');
                resetColors().catch(logError);
            }
        }),
    );
}

export function deactivate(): void {
    // Colors written to user settings are intentional and persist.
    // resetColors() is called during the session when the user disables the feature.
}


// ---------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------

/**
 * Reads the active VS Code color theme (including inherited themes via
 * "include") and layers workbench.colorCustomizations on top.
 * Returns a map of color token ID → hex color string.
 */
async function resolveThemeColors(): Promise<Map<string, string>> {
    const themeName = vscode.workspace
        .getConfiguration('workbench')
        .get<string>('colorTheme', '');

    log(`Resolving theme colors for: "${themeName}"`);

    const themeExt = findThemeExtension(themeName);
    if (!themeExt) {
        log(`WARNING: Could not find extension providing theme "${themeName}". No colors applied.`);
        return new Map();
    }

    log(`Found theme file: ${themeExt.filePath}`);
    const colors = await loadThemeColors(themeExt.filePath, new Set());
    log(`Loaded ${colors.size} color entries from theme (including inheritance).`);

    // Layer user's workbench.colorCustomizations on top.
    const userOverrides = vscode.workspace
        .getConfiguration('workbench')
        .get<Record<string, string>>('colorCustomizations', {});
    let overrideCount = 0;
    for (const [key, value] of Object.entries(userOverrides)) {
        if (typeof value === 'string') {
            colors.set(key, value);
            overrideCount++;
        }
    }
    if (overrideCount > 0) {
        log(`Applied ${overrideCount} workbench.colorCustomizations override(s).`);
    }

    return colors;
}

interface ThemeExtInfo {
    filePath: string;
}

function findThemeExtension(themeName: string): ThemeExtInfo | undefined {
    for (const ext of vscode.extensions.all) {
        const themes: Array<{ label?: string; id?: string; path?: string }> =
            ext.packageJSON?.contributes?.themes ?? [];
        for (const t of themes) {
            if (t.label === themeName || t.id === themeName) {
                if (t.path) {
                    log(`Theme "${themeName}" provided by extension: ${ext.id}`);
                    return { filePath: path.join(ext.extensionPath, t.path) };
                }
            }
        }
    }
    return undefined;
}

/** Recursively load and merge theme colors, following "include" inheritance. */
async function loadThemeColors(
    filePath: string,
    visited: Set<string>,
): Promise<Map<string, string>> {
    const real = path.resolve(filePath);
    if (visited.has(real)) {
        return new Map();
    }
    visited.add(real);

    let raw: string;
    try {
        raw = fs.readFileSync(real, 'utf8');
    } catch (err) {
        log(`WARNING: Could not read theme file "${real}": ${err}`);
        return new Map();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = parseJsonc(raw, undefined, { disallowComments: false });
    const result = new Map<string, string>();

    // Inherit from parent theme first.
    if (typeof json?.include === 'string') {
        const parentPath = path.resolve(path.dirname(real), json.include as string);
        log(`  Theme "${path.basename(real)}" includes parent: ${path.basename(parentPath)}`);
        const parentColors = await loadThemeColors(parentPath, visited);
        for (const [k, v] of parentColors) {
            result.set(k, v);
        }
    }

    // Child values override parent.
    const colors: Record<string, string> = json?.colors ?? {};
    for (const [key, value] of Object.entries(colors)) {
        if (typeof value === 'string') {
            result.set(key, value);
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Apply / reset colors
// ---------------------------------------------------------------------------

async function applyThemeColors(): Promise<void> {
    log('applyThemeColors: starting...');
    const themeColors = await resolveThemeColors();
    const rules = buildColorRules(themeColors);
    if (rules.length === 0) {
        log('applyThemeColors: no rules produced (theme may not define the requested ANSI colors). Settings unchanged.');
        return;
    }
    log(`applyThemeColors: applying ${rules.length} rule(s).`);
    await applyColors(rules);
    log('applyThemeColors: done.');
}

function buildColorRules(themeColors: Map<string, string>): TextMateRule[] {
    const extCfg = vscode.workspace.getConfiguration('buildOutputColorizer');
    const rules: TextMateRule[] = [];

    for (const scope of LOG_SCOPES) {
        const settingKey = SCOPE_TO_SETTING[scope].replace('buildOutputColorizer.', '');
        const colorKey = extCfg.get<string>(settingKey);
        if (!colorKey) {
            log(`  ${scope}: skipped (no colorKey setting)`);
            continue;
        }
        const color = themeColors.get(colorKey);
        if (!color) {
            log(`  ${scope}: skipped ("${colorKey}" not found in theme)`);
            continue;
        }
        log(`  ${scope}: ${colorKey} -> ${color}`);
        rules.push({ scope, settings: { foreground: color } });
    }

    return rules;
}

async function applyColors(newRules: TextMateRule[]): Promise<void> {
    const editorCfg = vscode.workspace.getConfiguration('editor');
    const existing = editorCfg.get<Record<string, unknown>>(
        'tokenColorCustomizations',
        {},
    );

    const existingRules: TextMateRule[] =
        (existing['textMateRules'] as TextMateRule[] | undefined) ?? [];

    // Remove any previously written rules for our scopes.
    const filtered = existingRules.filter(
        (r) => !(LOG_SCOPES as readonly string[]).includes(r.scope),
    );

    const merged = { ...existing, textMateRules: [...filtered, ...newRules] };

    log(`Writing ${newRules.length} rule(s) to editor.tokenColorCustomizations (global).`);
    await editorCfg.update(
        'tokenColorCustomizations',
        merged,
        vscode.ConfigurationTarget.Global,
    );
    log('editor.tokenColorCustomizations updated successfully.');
}

async function resetColors(): Promise<void> {
    log('resetColors: removing markup.other.log.* rules from editor.tokenColorCustomizations.');
    const editorCfg = vscode.workspace.getConfiguration('editor');
    const existing = editorCfg.get<Record<string, unknown>>(
        'tokenColorCustomizations',
        {},
    );

    const existingRules: TextMateRule[] =
        (existing['textMateRules'] as TextMateRule[] | undefined) ?? [];

    const removedScopes = existingRules
        .filter((r) => (LOG_SCOPES as readonly string[]).includes(r.scope))
        .map((r) => r.scope);
    log(`  Removing rules for: ${removedScopes.length > 0 ? removedScopes.join(', ') : '(none found)'}`);

    const filtered = existingRules.filter(
        (r) => !(LOG_SCOPES as readonly string[]).includes(r.scope),
    );

    const updated: Record<string, unknown> = { ...existing };
    if (filtered.length > 0) {
        updated['textMateRules'] = filtered;
    } else {
        delete updated['textMateRules'];
    }

    // If nothing remains in tokenColorCustomizations, remove it entirely.
    const value = Object.keys(updated).length === 0 ? undefined : updated;

    await editorCfg.update(
        'tokenColorCustomizations',
        value,
        vscode.ConfigurationTarget.Global,
    );
    log('resetColors: done.');
}
