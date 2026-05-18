#!/bin/sh
set -e

echo "NooHub diagnostics cleanup"
echo "Останавливаю старые задачи диагностики, если они запущены..."

systemctl list-units --all --no-legend 'noohub-traffic-capture-*' 2>/dev/null \
| awk '{print $1}' \
| xargs -r systemctl stop || true

systemctl stop noohub-cloud-trigger-monitor 2>/dev/null || true

echo "Удаляю helper-скрипты диагностики v10 из /usr/local/bin..."
rm -f /usr/local/bin/noohub_capture_traffic.sh
rm -f /usr/local/bin/noohub_install_tcpdump.sh
rm -f /usr/local/bin/noohub_cloud_trigger_monitor.sh

echo "Удаляю временные логи и файлы захвата диагностики..."
rm -rf /tmp/noohub_traffic
rm -f /tmp/noohub_cloud_trigger_monitor.log

if command -v tcpdump >/dev/null 2>&1; then
    echo "Найден tcpdump. Удаляю диагностический пакет tcpdump..."

    if command -v apt-get >/dev/null 2>&1; then
        if apt-get remove -y tcpdump; then
            echo "tcpdump удален."
        else
            echo "ВНИМАНИЕ: tcpdump не удалось удалить автоматически."
            echo "Проверьте вручную: apt-get remove -y tcpdump"
        fi
    else
        echo "ВНИМАНИЕ: apt-get не найден, tcpdump нужно удалить вручную."
    fi
else
    echo "tcpdump не найден, удалять нечего."
fi

echo "Готово. Диагностика v10, временные логи и helper-скрипты удалены."
