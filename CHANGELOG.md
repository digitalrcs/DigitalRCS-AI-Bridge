# Changelog

## 0.0.7

- Rename extension branding and configuration namespace to DigitalRCS.
- Package the bridge as `digitalrcs-vscode-ai-bridge`.

## 0.0.6

- Collect model output from `LanguageModelChatResponse.stream` first.
- Use `response.text` only as a fallback to avoid lossy provider convenience streams.

## 0.0.5

- Make model selection provider-neutral.
- Add optional `digitalrcs.aiBridge.defaultModel`.
- Keep Qwen `/no_think` behavior opt-in for local testing.

## 0.0.4

- Add configurable `digitalrcs.aiBridge.maxOutputTokens`.

## 0.0.1

- Initial local HTTP bridge for VS Code Language Model API access.

