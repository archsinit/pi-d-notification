# pi-d-notification

macOS reply notifications for [pi-d](https://github.com/archsinit/pi-d), implemented entirely as an extension.

- Short reply preview and notification sound.
- No alert while the chat's terminal pane is focused.
- Supports local **WezTerm** and **Ghostty**. No changes to pi-d or terminal configuration needed.

## Usage

Requires macOS and an existing pi-d installation. No dependency installation or build step is needed.

```sh
git clone https://github.com/archsinit/pi-d-notification.git
pi-d --extension "$PWD/pi-d-notification/index.mjs"
```

Restart pi-d to load the extension. Use the same `--extension` argument when reopening a session.

Allow notifications and sounds in macOS for the notification sender: Ghostty, or Script Editor / osascript for WezTerm. macOS Focus and sound settings still apply. Ghostty uses its default `desktop-notifications` setting.

Previews may contain sensitive text and appear on the lock screen. Adjust macOS notification preview settings if needed. tmux and SSH are not supported.

## Check it

```sh
cd pi-d-notification
npm test
npm run doctor                 # Read-only focus check
sleep 3; npm run doctor -- --notify  # Switch apps during the delay
```

Set `PI_D_NOTIFY=0` to disable alerts, or `PI_D_NOTIFY_PREVIEW_LENGTH` to adjust preview length (16–500 characters; default 160).
