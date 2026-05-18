# NooHub Bridge для Wiren Board и SprutHub

Мост для интеграции устройств NooHub / nooLite с виртуальными устройствами Wiren Board и SprutHub через отдельный MQTT-брокер.

Текущая версия пакета: `v11`.

## Возможности

- Создает виртуальные устройства NooHub в Wiren Board.
- Отправляет команды в NooHub через локальный HTTP API.
- Получает обратную связь через `get_state`.
- Сохраняет `Polling Enabled` и `Poll Interval, sec` в `/var/lib/wirenboard/noohub_bridge_config.json`.
- Поддерживает интервал polling от 1 до 180 секунд.
- Защищает Wiren Board от слишком частого polling: если цикл опроса не успевает завершаться или часто накладывается сам на себя, bridge автоматически поднимает интервал до 5 секунд и сохраняет настройку.
- Зеркалит MQTT-топики NooHub-устройств в отдельный Mosquitto-брокер для SprutHub.
- Содержит пользовательские шаблоны SprutHub для switch, dimmer и impulse.
- Содержит отдельный необязательный скрипт очистки старой временной диагностики из v10.

## Состав

- `noohub_bridge.js` - основной файл правил Wiren Board.
- `install_noohub_bridge.sh` - скрипт развертывания на Wiren Board.
- `noohub_delete_virtual_devices.sh` - helper для удаления виртуальных устройств NooHub.
- `noohub_resync_selected_devices.sh` - helper для выборочного Resync CH.
- `noohub_spruthub_mqtt_proxy.sh` - MQTT-прокси для SprutHub.
- `noohub_spruthub_mosquitto.*` - отдельный Mosquitto-сервис для SprutHub.
- `noohub_spruthub_mqtt_proxy.*` - конфигурация сервиса MQTT-прокси.
- `noohub_cleanup_diagnostics.sh` - необязательная очистка старой диагностики v10.
- `Custom/*.json` - пользовательские шаблоны SprutHub.

## Установка на Wiren Board

Скопируйте папку проекта на Wiren Board и выполните:

```sh
sh install_noohub_bridge.sh
```

Скрипт установки:

- делает резервную копию текущего `/etc/wb-rules/noohub_bridge.js`;
- устанавливает основной bridge-файл;
- устанавливает необходимые helper-скрипты;
- устанавливает и перезапускает отдельный Mosquitto-сервис для SprutHub;
- устанавливает и перезапускает MQTT-прокси;
- перезапускает `wb-rules`.

Скрипт установки не устанавливает и не удаляет `tcpdump`.

## Очистка старой диагностики

Если раньше была установлена временная диагностика трафика из v10, ее можно удалить вручную:

```sh
sh noohub_cleanup_diagnostics.sh
```

Скрипт удаляет старые helper-скрипты диагностики, временные логи захвата и пакет `tcpdump`, если он установлен.

## SprutHub

Загрузите шаблоны из папки `Custom/` через веб-интерфейс SprutHub:

- `NooHub-Switch.json`
- `NooHub-Dimmer.json`
- `NooHub-Impulse.json`

В MQTT-контроллере SprutHub укажите IP-адрес Wiren Board и порт отдельного брокера. Порт по умолчанию: `45883`.

## Важное про polling

На текущий момент NooHub отдает состояние через HTTP `get_state`, поэтому bridge использует polling для обратной связи.

Для стабильной работы лучше начинать с интервала 5-30 секунд. Интервал 1 секунда доступен для тестов и небольших установок, но при признаках перегрузки bridge сам поднимет интервал до 5 секунд.
