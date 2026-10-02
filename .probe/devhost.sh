#!/bin/bash
# Проверка расширения в Extension Development Host.
#
#   bash .probe/devhost.sh start           сборка + окно с отладочным профилем
#   bash .probe/devhost.sh case            сценарий «коуб во вкладке» целиком
#   bash .probe/devhost.sh layout          раскладка окна
#   bash .probe/devhost.sh views           плееры: панель и вкладка
#   bash .probe/devhost.sh stop            закрыть окно
#   bash .probe/devhost.sh restart         закрыть окно и поднять заново
#
# Окно запускается ровно один раз и само себя не перезапускает: пересборка
# подхватывается только явным restart. Переключатель Claude Sync стенд не
# трогает: он правит общий ~/.claude/settings.json, то есть и рабочую среду.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
PROFILE="$ROOT/.probe/vscode-user"
EXTENSIONS="$ROOT/.probe/vscode-ext"
WORKSPACE="$ROOT/.probe/workspace"
export CDP_PORT="${CDP_PORT:-9224}"
ARGS=(--user-data-dir="$PROFILE" --extensions-dir="$EXTENSIONS")
CHECK=(node "$ROOT/.probe/devhost-check.js")

cdp_up() { curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; }

# Только процессы этого отладочного профиля, чужие окна VS Code не трогаются.
host_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep -v grep | awk '{print $1}'; }
# Главный процесс приложения; хелперы живут в своих бандлах Code Helper….app.
main_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep "Code.app/Contents/MacOS/Code " | grep -v grep | awk '{print $1}'; }

prepare_profile() {
	mkdir -p "$PROFILE/User" "$EXTENSIONS" "$WORKSPACE"
	# Пустой профиль иначе встречает приветствием и чатом, которые съедают ввод палитры.
	cat > "$PROFILE/User/settings.json" <<'JSON'
{
	"workbench.startupEditor": "none",
	"workbench.welcomePage.walkthroughs.openOnInstall": false,
	"chat.commandCenter.enabled": false,
	"update.mode": "none",
	"update.showReleaseNotes": false,
	"telemetry.telemetryLevel": "off",
	"extensions.autoUpdate": false
}
JSON
	# Профиль помнит вкладки прошлого прогона.
	rm -rf "$PROFILE/User/workspaceStorage" "$PROFILE/User/History"
}

case "${1:-}" in
start)
	npm run compile 2>&1 | grep -E "error TS" && { echo "сборка упала"; exit 1; }
	if cdp_up; then echo "окно уже запущено (CDP на $CDP_PORT)"; exit 0; fi
	prepare_profile
	"$CODE" "${ARGS[@]}" --remote-debugging-port="$CDP_PORT" \
		--extensionDevelopmentPath="$ROOT" --new-window "$WORKSPACE" \
		--disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
		> "$ROOT/.probe/devhost.log" 2>&1 &
	for _ in $(seq 1 30); do sleep 2; cdp_up && { echo "окно готово, CDP на $CDP_PORT"; exit 0; }; done
	echo "окно не поднялось за 60 с, см. .probe/devhost.log"; exit 1
	;;

case)
	bash "$0" restart || exit 1

	echo "== раскрываю панель Coub"
	"${CHECK[@]}" cmd "Coub Player: Focus on Coub Player View" > /dev/null || exit 1
	for _ in $(seq 1 15); do sleep 2; "${CHECK[@]}" views 2>/dev/null | grep -q '"panel"' && break; done

	echo "== коуб в панели"
	PANEL_BEFORE="$("${CHECK[@]}" wait panel 60)" || { echo "$PANEL_BEFORE"; exit 1; }
	echo "$PANEL_BEFORE"

	FAIL=0
	echo "$PANEL_BEFORE" | grep -q '"есть_кнопка_Tab": true' || { echo "ОТКАЗ: в панели нет кнопки Tab"; FAIL=1; }

	echo "== жму кнопку Tab"
	"${CHECK[@]}" click panel '#tab-btn' || FAIL=1
	for _ in $(seq 1 15); do sleep 2; "${CHECK[@]}" views 2>/dev/null | grep -q '"tab"' && break; done

	echo "== раскладка"
	"${CHECK[@]}" layout

	echo "== коуб во вкладке"
	TAB="$("${CHECK[@]}" wait tab 60)" || { echo "$TAB"; echo "ОТКАЗ: плеер во вкладке не открылся"; FAIL=1; }
	echo "$TAB"
	echo "$TAB" | grep -q '"есть_кнопка_Tab": false' || { echo "ОТКАЗ: во вкладке осталась кнопка Tab"; FAIL=1; }
	echo "$TAB" | grep -q '"пауза": false' || { echo "ОТКАЗ: вкладка не играет"; FAIL=1; }

	echo "== панель под вкладкой"
	PANEL_AFTER="$("${CHECK[@]}" wait panel 20)" || { echo "$PANEL_AFTER"; exit 1; }
	echo "$PANEL_AFTER"
	echo "$PANEL_AFTER" | grep -q '"пауза": true' || { echo "ОТКАЗ: панель играет вместе с вкладкой"; FAIL=1; }

	echo "== Next во вкладке не двигает панель"
	"${CHECK[@]}" click tab '#next-btn' > /dev/null || FAIL=1
	sleep 6
	TAB_NEXT="$("${CHECK[@]}" wait tab 40)" || FAIL=1
	PANEL_STILL="$("${CHECK[@]}" wait panel 20)" || FAIL=1
	TAB_SRC_1="$(echo "$TAB" | grep '"видео"')"
	TAB_SRC_2="$(echo "$TAB_NEXT" | grep '"видео"')"
	PANEL_SRC_1="$(echo "$PANEL_BEFORE" | grep '"видео"')"
	PANEL_SRC_2="$(echo "$PANEL_STILL" | grep '"видео"')"
	[ "$TAB_SRC_1" != "$TAB_SRC_2" ] || { echo "ОТКАЗ: Next во вкладке не сменил коуб"; FAIL=1; }
	[ "$PANEL_SRC_1" = "$PANEL_SRC_2" ] || { echo "ОТКАЗ: коуб в панели сменился вслед за вкладкой"; FAIL=1; }

	if [ "$FAIL" -eq 0 ]; then echo "== сценарий пройден"; else echo "== сценарий провален"; fi
	exit "$FAIL"
	;;

layout|views|targets|wait|click|eval|cmd)
	"${CHECK[@]}" "$@"
	;;

restart)
	bash "$0" stop || exit 1
	bash "$0" start
	;;

stop)
	[ -z "$(host_pids)" ] && { echo "окно не запущено"; exit 0; }
	# SIGTERM только главному процессу: Electron отвечает на него обычным
	# выходом, как на Cmd+Q. Убитые по отдельности хелперы и kill -9 VS Code
	# считает падением и восстанавливает окно поверх остальных.
	MAIN="$(main_pids)"
	[ -z "$MAIN" ] && { echo "главный процесс не найден, остались: $(host_pids)"; exit 1; }
	echo "$MAIN" | xargs kill -TERM 2>/dev/null
	for _ in $(seq 1 30); do sleep 1; [ -z "$(host_pids)" ] && { echo "окно закрыто"; exit 0; }; done
	echo "окно не закрылось за 30 с, процессы: $(host_pids) — принудительно не добиваю"; exit 1
	;;

*)
	grep '^#' "$0" | sed -n '2,14p' | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
