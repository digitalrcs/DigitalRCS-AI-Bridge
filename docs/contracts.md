# DigitalRCS AI Bridge HTTP contract

The extension exposes VS Code language models to the separate DigitalRCS desktop
application through a small local HTTP API. The default base URL is
`http://127.0.0.1:8787`.

Every request, including health checks, must send:

```http
Authorization: Bearer <token>
```

Use **DigitalRCS AI Bridge: Copy Bearer Token** from the VS Code Command Palette to
copy the current token. The token is taken from
`digitalrcs.aiBridge.sharedToken` when that setting is non-empty. Otherwise, the
extension generates 24 random bytes as a hexadecimal string and persists it in
VS Code workspace state. Tokens are never written to the output channel.

All responses use one of these envelopes:

```json
{ "ok": true, "...": "route-specific fields" }
```

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

## `GET /bridge/health`

Returns bridge liveness and the number of currently available language models:

```json
{ "ok": true, "status": "running", "modelCount": 3 }
```

## `GET /bridge/models`

Returns the available opaque model IDs in ascending order:

```json
{ "ok": true, "models": ["model-a", "model-b"] }
```

Model IDs can change as model-provider extensions change. DigitalRCS should refresh
this route instead of treating the list as permanent.

## `POST /bridge/analyze`

Request using raw result data:

```json
{
  "model": "optional-model-id",
  "prompt": "System instruction string",
  "resultData": {
    "score": 95,
    "findings": []
  },
  "useManualInput": false,
  "manualInput": "",
  "requestId": "optional-client-correlation-id"
}
```

Request using manual input:

```json
{
  "model": "optional-model-id",
  "prompt": "System instruction string",
  "useManualInput": true,
  "manualInput": "The user-provided text to analyze.",
  "requestId": "optional-client-correlation-id"
}
```

`prompt` is always required. When `useManualInput` is false or omitted,
`resultData` must be a non-null JSON object. When `useManualInput` is true,
`manualInput` must be a non-empty string and `resultData` is ignored. The
`model` value is a VS Code language model ID from `/bridge/models`. An omitted
model or `"Auto"` uses `digitalrcs.aiBridge.defaultModel` when configured, otherwise
the first model returned by VS Code. An unrecognized or unavailable model ID
falls back to the first available model.

Successful response:

```json
{
  "ok": true,
  "analysis": "Plain-text model response.",
  "requestId": "optional-client-correlation-id"
}
```

## Errors

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `BAD_REQUEST` | Invalid JSON or request fields |
| 401 | `UNAUTHORIZED` | Missing or invalid bearer token |
| 404 | `NOT_FOUND` | Unknown route |
| 413 | `REQUEST_TOO_LARGE` | Body exceeds `digitalrcs.aiBridge.maxRequestBytes` |
| 429 | `RATE_LIMITED` | Rolling request limit exceeded |
| 503 | `AI_UNAVAILABLE` | No model is available or the model request failed |
| 500 | `INTERNAL_ERROR` | Unexpected bridge failure |

## Operational and security notes

- The server uses Node's built-in `node:http`; it has no Express or runtime npm
  dependencies.
- The host defaults to `127.0.0.1`. Changing it can expose the bridge to other
  machines and should be done only with appropriate network controls.
- Request size is enforced while the body is being read.
- Rate limiting uses a rolling 60-second array and does not create a timer.
- The bridge requests up to 65,536 model output tokens by default. Configure
  `digitalrcs.aiBridge.maxOutputTokens` between 256 and 262,144; the selected model
  or server can enforce a lower effective limit.
- The bridge is provider-neutral: it only calls VS Code's Language Model API and
  does not call LM Studio, OpenAI, Anthropic, Kimi, or other backends directly.
- `digitalrcs.aiBridge.qwenNoThinkPrefix` is an opt-in local workaround for
  Qwen-family VS Code language models whose provider routes final text through
  reasoning output.
- User-provided input is passed as model text only. It is never used to build
  shell commands and is never evaluated as code.
- Model response diagnostics report object shape and fragment counts, not the
  bearer token. The bridge collects text from `LanguageModelChatResponse.stream`
  first, using `LanguageModelTextPart.value`, and only falls back to
  `LanguageModelChatResponse.text` when no stream text is available.
