#!/usr/bin/env bash
# Автозапуск просмотрщика: ставит LaunchAgent, который поднимает сервер при входе в систему
# и перезапускает его, если процесс упал. Снять: bash install-agent.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="digital.belkin.docviewer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Автозапуск снят. Сервер остановлен."
  exit 0
fi

NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || { echo "Не найден node — установите его и повторите." >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HERE/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DOCVIEWER_NO_OPEN</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/docviewer.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/docviewer.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "Автозапуск установлен: $PLIST"
echo "Журнал: $LOG_DIR/docviewer.log"
