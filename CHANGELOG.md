# Change Log

## v1.0.0

- Add optional theme-tracking mode (`buildOutputColorizer.useTerminalColors`): reads the active VS Code color theme's terminal ANSI colors and applies them to log highlight scopes, updating automatically on theme change
- Add per-scope ANSI color key settings (`errorColorKey`, `warnColorKey`, `infoColorKey`, `debugColorKey`, `highlightColorKey`)
- Add opt-in diagnostic logging (`buildOutputColorizer.enableDiagnosticLogging`)

## v0.1.0

- Initial release