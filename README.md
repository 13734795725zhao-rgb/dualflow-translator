<div align="center">
  <img src="docs/assets/banner.svg" alt="DualFlow Translator — bilingual page translation with your own API key" width="880">
</div>

<br>

<div align="center">

**网页双语对照翻译，用你自己的 API Key。**

不订阅、不中转、不上传。翻译直接显示在原文下面，左侧一条蓝色标线，一眼分得清。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4)](#install)
[![BYOK](https://img.shields.io/badge/BYOK-your%20key%2C%20your%20quota-blue)](#privacy)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Features](#features) · [Install](#install) · [First setup](#first-setup) · [Providers](#supported-ai-services) · [Troubleshooting](#troubleshooting)

</div>

---

## Why this one

Most bilingual translation extensions want a monthly fee, send your page text through their server, or both. You probably already pay for an AI API. So this one just uses it.

Point it at DeepSeek, OpenAI, Gemini, Claude, a local Ollama, or anything else that follows the OpenAI format. Translations appear **right under each paragraph**, quietly styled next to the original. Nothing leaves your browser except the paragraphs being translated, and they go straight to the service you configured.

---

## Features

| | |
|---|---|
| **Translation sits under the original** | Each translated paragraph appears directly below its source, with a thin blue line on the left and a soft background. Page layout stays intact |
| **Skips menus and labels** | Navigation, breadcrumbs, `HOME`, `Sign in` and menus full of short links are left alone — no wasted tokens, no broken menus |
| **Handles awkward pages** | Works on ordinary articles and on pages built from loose text separated by line breaks, like news sites and blog engines |
| **Ignores code blocks** | Scripts, styles, preformatted blocks and inline code are not sent to the model |
| **Chinese pages cost nothing** | Paragraphs that are already Chinese are skipped instantly, with no request made |
| **Waits for you to scroll** | Paragraphs below the fold translate when you reach them |
| **Copes with lazy pages** | Content that loads later still gets translated |
| **Removes itself cleanly** | One click puts the page back exactly as it was |
| **Three modes** | Translate every page automatically, only when you ask, or never — your choice, stored once |

---

## Install

### From source (recommended — no build step)

```bash
git clone https://github.com/13734795725zhao-rgb/dualflow-translator.git
```

1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the folder you just cloned — the one containing `manifest.json`
4. Pin it to the toolbar (puzzle icon → pin)

Edge, Brave and Arc work the same way. The default shortcut is <kbd>Alt</kbd>+<kbd>T</kbd>; change it at `chrome://extensions/shortcuts`.

### From a release

Download the `.zip` from [Releases](https://github.com/13734795725zhao-rgb/dualflow-translator/releases), unzip it, then **Load unpacked** the unzipped folder.

> Chrome 137 and later blocks double-clicking a local `.crx` file. Loading the folder, or uploading the zip to the Web Store, are the supported routes.

---

## First setup

1. Click the extension icon → <kbd>⚙</kbd> to open **Settings**
2. **Model registry → + Add provider** → pick a preset (DeepSeek, for example) → paste your API key → Save
3. Under that provider, **+ Add model** — the usual model names are already filled in → Save
4. Back in the popup, choose that model under **Active model**, then pick a mode:

| Mode | What happens |
|---|---|
| **Manual** (default) | Nothing is translated until you click the switch on a page. No surprise spending |
| **Always on** | Every page you open is translated. This does use your quota on every site |
| **Always off** | Nothing translates automatically; the per-page switch still works |

Translations appear under each paragraph. Hover one to **copy** it or **hide that sentence**. A paragraph that failed shows a pale red **Retry** bar.

> Dislike a site? Tick **Disable translation on this site** at the bottom of the popup. That always wins over "Always on".

---

## Supported AI services

| Service | Default address |
|---|---|
| DeepSeek | `api.deepseek.com/v1` |
| OpenAI | `api.openai.com/v1` |
| Google Gemini | `generativelanguage.googleapis.com/v1beta` |
| Anthropic Claude | `api.anthropic.com` |
| SiliconFlow | `api.siliconflow.cn/v1` |
| Moonshot / Kimi | `api.moonshot.cn/v1` |
| Alibaba Bailian / Qwen | `dashscope.aliyuncs.com/compatible-mode/v1` |
| Zhipu GLM | `open.bigmodel.cn/api/paas/v4` |
| Ollama (local) | `localhost:11434/v1` |
| LM Studio (local) | `localhost:1234/v1` |
| Anything else | Any compatible address you type in |

**Address handling:** if you only type the domain, `/v1` is added for you. If you paste a full path, it is used as-is. There is also an override field if you need to force an exact address. The popup always shows the address it will actually call, so you can compare it with your provider's documentation.

**Self-check:** Settings → Model registry → **Start self-check**. It walks through four steps — settings, address, connection, and reading the reply — and tells you what to fix at each one.

---

## Troubleshooting

**If a slow model is the problem, you will at least see grey placeholder bars first.** No bars at all means the request is not arriving.

| What you see | What it usually means | What to do |
|---|---|---|
| Nothing happens on the page | The tab was open before the extension was installed | The popup offers **Reload page and translate** — use it |
| `404` | The address is wrong or has `/v1` twice | Run the self-check; it prints the exact address being called |
| `401` / `403` | The key is wrong, or has no access to that model | Fix the key in Settings |
| `429` | Too many requests, or out of quota | Wait, or switch to another model |
| The reply arrives but nothing appears | The model answered in an odd format | The extension already cleans up the common cases; if it persists, try another model |

Every request logs the address it actually used, with your key hidden:

```
[DualFlow] actual request URL: https://api.deepseek.com/v1/chat/completions | model=deepseek-chat
```

---

## Privacy

- Your API key, address and headers are stored **only inside the browser**, in the extension's own storage.
- Requests go **straight from the extension to the address you configured**. There is no relay, no tracking, no analytics.
- Logs hide credentials before they reach the console.
- Permissions asked for: `storage`, `activeTab`, and access to model addresses. Nothing else.

---

## Good to know

- Only the top-level page is translated, not embedded frames.
- Translations appear when a whole batch comes back, so very long paragraphs do not stream character by character.
- Off-screen paragraphs translate when you scroll to them.
- PDFs and ebooks are not supported.
- The interface is in Chinese.

---

## More

| Document | Contents |
|---|---|
| [`docs/README.zh-CN.md`](docs/README.zh-CN.md) | Full documentation in Chinese — feature tables, detailed troubleshooting |

## License

[MIT](LICENSE) © 2026 幻蝶

---

<div align="center">
<sub>Your key. Your quota. Your page.</sub>
</div>
