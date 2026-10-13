# Clippy

A Chrome extension for clipboard history and reusable snippets. Snippets can do more than paste fixed text: they can fill in dynamic variables, clean up formatting, and suggest themselves on the sites where you use them. Everything is stored locally in your browser profile; nothing is synced or sent anywhere.

## Features

**Palette** (`⌘⇧Space` on Mac, `Ctrl+Shift+Space` elsewhere): one search box over your snippets and clipboard history. Results are fuzzy-matched, and a live preview shows exactly what will be inserted.

| Key | Action |
| --- | --- |
| `↵` | Insert into the field you were typing in |
| `⇧↵` | Copy instead of inserting |
| `Tab` | Choose cleanups to apply (uppercase, strip tracking, pretty JSON…) |
| `Esc` | Close and return focus to the page |

If there is no text field to insert into, Clippy copies the result to your clipboard and shows a "press ⌘V" toast.

**Trigger expansion**: type `;bug` and then Space or Tab, and the snippet replaces the trigger as you type. This works in inputs, textareas and rich editors such as Gmail and Slack. You can change the prefix or turn expansion off in Settings.

**Dynamic variables**

| Variable | Result |
| --- | --- |
| `{{date}}` / `{{date:dddd, D MMM YYYY}}` | Today's date, with an optional format |
| `{{time}}` / `{{time:h:mm A}}` | Current time |
| `{{clipboard}}` | Current clipboard text (including copies made in other apps) |
| `{{selection}}` | Text selected on the page |
| `{{url}}`, `{{title}}`, `{{host}}` | Details of the current page |
| `{{input:Name\|default}}` | Asks you for a value in a small form before inserting |
| `{{select:Tone\|warm\|formal}}` | Lets you pick one of the listed options |
| `{{cursor}}` | Where the caret lands after inserting |
| `{{snippet:sig}}` | Includes another snippet (nesting is limited to 3 levels) |

Write `\{{` to insert a literal `{{`.

**Clipboard history** records text you copy on web pages, including text written by "Copy" buttons through `navigator.clipboard`. In the popup you can search, pin, delete and clear items, or turn one into a snippet. Some copies are never recorded:

- copies from password and one-time-code fields
- copies in incognito windows
- copies on sites you exclude
- text that looks like a secret: API keys (OpenAI/Anthropic, AWS, GitHub, Stripe, Slack, Google), JWTs, private keys, card numbers that pass the Luhn check, and random-looking tokens

Detection of secrets can be turned off in Settings.

**Paste clean** (`⌥⇧V`): pastes your clipboard after running the cleanup chain you set in Settings. The default chain removes invisible characters, strips tracking parameters such as `utm_*` and `fbclid` from URLs, and trims whitespace.

**Site-aware suggestions**: give a snippet site patterns such as `github.com` or `*.atlassian.net`, and it appears first in the palette on those sites. Snippets you use often on a site also move up there automatically.

**Save selection as snippet**: right-click any selected text to save it as a snippet. Right-clicking inside a text field gives "Insert Clippy snippet…".

You can export your snippets to JSON and import them again from the Settings tab.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this `clippy/` folder.
3. Optional: change the shortcuts at `chrome://extensions/shortcuts`.

On first install Clippy adds five sample snippets: `;date`, `;fu`, `;bug`, `;qc` and `;link`.

## Limitations

- Clipboard history only records copies made on web pages in Chrome. Copies from other macOS apps are not recorded, because a browser extension can't watch the system clipboard. However, `{{clipboard}}` and Paste clean do read the current system clipboard.
- Clippy can't run on `chrome://` pages, the Chrome Web Store or the PDF viewer.
- Rich text is stored as plain text.

## Project layout

```
manifest.json      MV3 manifest: content scripts, commands, permissions
background.js      service worker: the only writer to storage; commands and context menus
content.js         copy capture, palette (closed shadow DOM), trigger expansion, insertion
page-hook.js       MAIN-world hook that relays navigator.clipboard.writeText() calls
lib/templates.js   variable parser and renderer
lib/cleanup.js     text transforms
lib/search.js      fuzzy ranking, host matching, suggestions
lib/sensitive.js   secret and card-number detection
lib/defaults.js    default settings shared by every context
popup/             library, history and settings UI
test/              unit tests, end-to-end test, playground page
```

The `lib/` files are plain scripts that attach to `globalThis.Clippy`. The same files run in the content script, the popup, the service worker and Node, so there is no build step.

## Tests

```sh
npm install         # dev-only: puppeteer-core
npm test            # unit tests for lib/ (node --test)
npm run test:e2e    # loads the extension into Chrome and drives test/playground.html
```

The end-to-end run uses your installed Google Chrome. Set `CHROME_PATH` to use a different browser, and `SHOTS=dir` to save the screenshots it takes. The checks cover:

- copy capture, both the `writeText` hook and `setData`
- skipping secrets
- trigger expansion in input, textarea and contenteditable
- caret placement
- fill-in forms
- palette search, cleanup and Esc handling
- Paste clean
- the popup editor and settings
- pausing recording

For manual testing, serve `test/playground.html` over HTTP, or enable "Allow access to file URLs" for the extension and open the file directly.
