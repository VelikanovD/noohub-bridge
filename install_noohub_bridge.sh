#!/bin/sh
set -e

echo "Создаю резервную копию текущего noohub_bridge.js, если он существует..."
if [ -f /etc/wb-rules/noohub_bridge.js ]; then
    cp /etc/wb-rules/noohub_bridge.js /etc/wb-rules/noohub_bridge.js.bak.$(date +%Y%m%d-%H%M%S)
fi

echo "Устанавливаю файл wb-rules..."
cp ./noohub_bridge.js /etc/wb-rules/noohub_bridge.js

echo "Устанавливаю вспомогательные скрипты..."
cp ./noohub_delete_virtual_devices.sh /usr/local/bin/noohub_delete_virtual_devices.sh
cp ./noohub_resync_selected_devices.sh /usr/local/bin/noohub_resync_selected_devices.sh
chmod +x /usr/local/bin/noohub_delete_virtual_devices.sh
chmod +x /usr/local/bin/noohub_resync_selected_devices.sh

if [ -f ./noohub_spruthub_mqtt_proxy.sh ]; then
    echo "Устанавливаю MQTT-прокси NooHub для SprutHub..."
    cp ./noohub_spruthub_mqtt_proxy.sh /usr/local/bin/noohub_spruthub_mqtt_proxy.sh
    chmod +x /usr/local/bin/noohub_spruthub_mqtt_proxy.sh
fi

if [ -f ./noohub_spruthub_mqtt_proxy.env ]; then
    if [ -f /etc/default/noohub_spruthub_mqtt_proxy ]; then
        echo "Сохраняю существующие настройки MQTT-прокси NooHub..."
    else
        cp ./noohub_spruthub_mqtt_proxy.env /etc/default/noohub_spruthub_mqtt_proxy
    fi
fi

if [ -f /etc/mosquitto/acl.d/noohub_spruthub.acl ]; then
    echo "Удаляю старый ACL отдельного брокера, он больше не нужен..."
    rm -f /etc/mosquitto/acl.d/noohub_spruthub.acl
fi

if [ -f /etc/mosquitto/conf.d/noohub_spruthub_mqtt_listener.conf ]; then
    echo "Удаляю старый MQTT-listener из основного Mosquitto..."
    rm -f /etc/mosquitto/conf.d/noohub_spruthub_mqtt_listener.conf
    systemctl restart mosquitto
fi

if [ -f ./noohub_spruthub_mosquitto.conf ]; then
    if [ -f /etc/mosquitto/noohub_spruthub_mosquitto.conf ]; then
        echo "Сохраняю существующий порт отдельного MQTT-брокера NooHub..."
    else
        echo "Устанавливаю отдельный MQTT-брокер 0.0.0.0:45883 для NooHub..."
        cp ./noohub_spruthub_mosquitto.conf /etc/mosquitto/noohub_spruthub_mosquitto.conf
    fi
fi

if [ -f ./noohub_spruthub_mosquitto.service ]; then
    cp ./noohub_spruthub_mosquitto.service /etc/systemd/system/noohub_spruthub_mosquitto.service
    systemctl daemon-reload
    systemctl enable noohub_spruthub_mosquitto.service
    systemctl restart noohub_spruthub_mosquitto.service
fi

if [ -f ./noohub_spruthub_mqtt_proxy.service ]; then
    cp ./noohub_spruthub_mqtt_proxy.service /etc/systemd/system/noohub_spruthub_mqtt_proxy.service
    systemctl daemon-reload
    systemctl enable noohub_spruthub_mqtt_proxy.service
    systemctl restart noohub_spruthub_mqtt_proxy.service
fi

echo "SprutHub: шаблоны из папки Custom нужно загрузить через веб-интерфейс SprutHub."

echo "Перезапускаю wb-rules..."
systemctl restart wb-rules

echo "Готово. Логи: journalctl -u wb-rules -n 150 --no-pager | grep NooHub"
echo "SprutHub: загрузите шаблоны из папки Custom, затем запустите поиск устройств в MQTT-контроллере."
