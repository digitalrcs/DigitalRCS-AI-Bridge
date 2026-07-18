# DigitalRCS VS Code AI Bridge

DigitalRCS VS Code AI Bridge is a local-only Visual Studio Code extension that
exposes VS Code language models through a small bearer-token-protected HTTP API.
It is intended for desktop applications that need to ask a model for analysis
without embedding provider-specific API keys or SDKs.

The extension is provider-neutral. It only calls VS Code's Language Model API:

- `vscode.lm.selectChatModels()`
- `model.sendRequest()`

The actual model backend is whatever the user's VS Code environment exposes:
GitHub Copilot, LM Studio through a VS Code provider, OpenAI, Claude, Kimi, or
another compatible VS Code language model provider.

## What It Provides

- Local HTTP bridge, defaulting to `http://127.0.0.1:8787`
- Bearer-token authentication on every route
- Model discovery through VS Code's Language Model API
- Plain-text analysis responses for desktop applications
- Configurable host, port, token, rate limit, input size, and output-token hint
- Provider-neutral model selection with optional local default model

## Install From VSIX

Download the `.vsix` from a GitHub release, then install it:

```powershell
code --install-extension "digitalrcs-vscode-ai-bridge-0.0.7.vsix" --force
```

Reload VS Code after installing or upgrading.

## Use In VS Code

Open the Command Palette and run:

- `DigitalRCS AI Bridge: Start`
- `DigitalRCS AI Bridge: Stop`
- `DigitalRCS AI Bridge: Show Status`
- `DigitalRCS AI Bridge: Copy Bearer Token`
- `DigitalRCS AI Bridge: Run Smoke Test`

The smoke test opens the `DigitalRCS AI Bridge` output channel and logs model
selection, response shape, stream collection diagnostics, and the returned text.

## Configuration

Settings use the `digitalrcs.aiBridge.*` namespace:

| Setting | Default | Purpose |
| --- | --- | --- |
| `digitalrcs.aiBridge.autoStart` | `false` | Start the bridge when the extension activates |
| `digitalrcs.aiBridge.host` | `127.0.0.1` | Interface to bind |
| `digitalrcs.aiBridge.port` | `8787` | HTTP port |
| `digitalrcs.aiBridge.sharedToken` | `""` | Optional fixed bearer token |
| `digitalrcs.aiBridge.defaultModel` | `""` | Optional model ID used when callers omit model or send `Auto` |
| `digitalrcs.aiBridge.maxRequestBytes` | `5242880` | Maximum JSON request size |
| `digitalrcs.aiBridge.maxOutputTokens` | `65536` | Output-token hint passed via `modelOptions.maxOutputTokens` |
| `digitalrcs.aiBridge.qwenNoThinkPrefix` | `false` | Optional local workaround that prepends `/no_think` for Qwen-family models |
| `digitalrcs.aiBridge.requestsPerMinute` | `30` | Rolling per-minute authenticated request limit |

If `digitalrcs.aiBridge.sharedToken` is empty, the extension generates a random
token and stores it in VS Code workspace state. Use `DigitalRCS AI Bridge: Copy
Bearer Token` to copy it.

## HTTP API

Every request must include:

```http
Authorization: Bearer <token>
```

### Health

```http
GET /bridge/health
```

Example:

```powershell
$token = "<copied-token>"
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/bridge/health" `
  -Headers @{ Authorization = "Bearer $token" }
```

### Models

```http
GET /bridge/models
```

Returns model IDs available through VS Code.

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/bridge/models" `
  -Headers @{ Authorization = "Bearer $token" }
```

### Analyze

```http
POST /bridge/analyze
```

Manual input example:

```powershell
$body = @{
  model = "Auto"
  prompt = "Analyze this data and return concise plain text."
  useManualInput = $true
  manualInput = "The service recovered after failover but had 90 seconds of downtime."
  requestId = "example-001"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/bridge/analyze" `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $token" } `
  -Body $body
```

Structured data example:

```json
{
  "model": "Auto",
  "prompt": "Analyze this result data and return plain text.",
  "useManualInput": false,
  "resultData": {
    "service": "inventory-api",
    "downtimeSeconds": 90,
    "failoverSucceeded": true
  },
  "requestId": "example-002"
}
```

Successful response:

```json
{
  "ok": true,
  "analysis": "Plain-text model response.",
  "requestId": "example-001"
}
```

Error response:

```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Human-readable error message."
  }
}
```

See `docs/contracts.md` for the full route contract.

## Build And Package

```powershell
npm test
npx --yes @vscode/vsce@latest package --out digitalrcs-vscode-ai-bridge-0.0.7.vsix
```

The project has no runtime npm dependencies. It uses Node built-ins and the
VS Code extension API.

## Security Notes

- The bridge binds to `127.0.0.1` by default.
- Every route requires a bearer token.
- Tokens are never logged.
- Request size is enforced while reading the body.
- Rate limiting uses a rolling 60-second request log.
- User input is passed only as model text. It is not used in shell commands and
  is not evaluated as code.

## License

This project is licensed under GPL-3.0-or-later. See `LICENSE`.

