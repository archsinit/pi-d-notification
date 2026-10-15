# pi-d-notification

macOS reply notifications for [pi-d](https://github.com/archsinit/pi-d), implemented entirely as an extension.

- Short reply preview and notification sound.
- No alert while the chat's terminal pane is focused.
- Per-session `/notifications` toggle and footer bell.
- Supports local **WezTerm** and **Ghostty**. All notification behavior stays in the extension; no terminal configuration needed.

## Usage

Requires macOS and pi-d with the command/footer and toast extension APIs ([`67d718c`](https://github.com/archsinit/pi-d/commit/67d718c) or newer). No extension dependency installation or build step is needed.

```sh
git clone https://github.com/archsinit/pi-d-notification.git
pi-d --extension "$PWD/pi-d-notification/index.mjs"
```

Restart pi-d to load changes. Use the same `--extension` argument when reopening, or place/link this repository in `~/.config/pi-d/extensions/pi-d-notification/` for automatic loading (under `$XDG_CONFIG_HOME/pi-d/extensions/` when configured).

Allow notifications and sounds in macOS for the notification sender: Ghostty, or Script Editor / osascript for WezTerm. macOS Focus and sound settings still apply. Ghostty uses its default `desktop-notifications` setting.

Previews may contain sensitive text and appear on the lock screen. Adjust macOS notification preview settings if needed. tmux and SSH are not supported.

## Per-session controls

| Command | Effect |
| --- | --- |
| `/notifications` | Toggle this session's notifications |
| `/notifications on` | Enable them |
| `/notifications off` | Mute them |

The footer shows a **gold bell** when enabled and a **gray crossed-out bell** when muted. `on`/`off` complete with Tab; the command appears in `/help`. Commands are local and make no model request. Confirmation appears in a temporary toast, leaving the bottom information bar visible.

Notifications default to on. The preference is saved in the session's native Durable document, survives reopen and `/new`, and does not change other sessions. Muted replies are not replayed after unmuting. Focus suppression still applies when enabled.

`PI_D_NOTIFY=0` or `PI_D_NOTIFY=false` overrides the session preference for that process: the bell stays muted and the command explains the override. Restart without that variable to use the saved preference again.

## Check it

```sh
cd pi-d-notification
npm test
PI_D_HOST_PATH=/path/to/pi-d npm test  # Also test native persistence, commands and footer
npm run doctor                 # Read-only focus check
sleep 3; npm run doctor -- --notify  # Switch apps during the delay
```

Set `PI_D_NOTIFY_PREVIEW_LENGTH` to adjust preview length (16–500 graphemes; default 160). Automated tests use fake delivery and temporary sessions, never real notifications or sounds.
