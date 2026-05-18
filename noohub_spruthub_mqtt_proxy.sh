#!/bin/sh

LOG="/tmp/noohub_spruthub_mqtt_proxy.log"
NOOHUB_SPRUTHUB_MQTT_HOST="${NOOHUB_SPRUTHUB_MQTT_HOST:-127.0.0.1}"
NOOHUB_SPRUTHUB_MQTT_PORT="${NOOHUB_SPRUTHUB_MQTT_PORT:-45883}"
NOOHUB_SPRUTHUB_ALLOWED_IDS="${NOOHUB_SPRUTHUB_ALLOWED_IDS:-}"
NOOHUB_SPRUTHUB_BLOCK_ALL="${NOOHUB_SPRUTHUB_BLOCK_ALL:-0}"
NOOHUB_SPRUTHUB_MIRROR_LEGACY_PREFIX="${NOOHUB_SPRUTHUB_MIRROR_LEGACY_PREFIX:-0}"
WB_MQTT_HOST="${WB_MQTT_HOST:-127.0.0.1}"
WB_MQTT_PORT="${WB_MQTT_PORT:-1883}"

echo "===== NooHub SprutHub MQTT proxy started $(date) =====" >> "$LOG"
echo "WB MQTT: ${WB_MQTT_HOST}:${WB_MQTT_PORT}, SprutHub MQTT: ${NOOHUB_SPRUTHUB_MQTT_HOST}:${NOOHUB_SPRUTHUB_MQTT_PORT}" >> "$LOG"
echo "Allowed IDs: ${NOOHUB_SPRUTHUB_ALLOWED_IDS:-ALL}, block_all=${NOOHUB_SPRUTHUB_BLOCK_ALL}" >> "$LOG"
echo "Mirror legacy /noohub prefix: ${NOOHUB_SPRUTHUB_MIRROR_LEGACY_PREFIX}" >> "$LOG"

noohub_device_id_from_topic() {
    case "$1" in
        /devices/noohub_*)
            id="${1#/devices/noohub_}"
            id="${id%%/*}"
            printf '%s\n' "$id"
            ;;
        /noohub/devices/noohub_*)
            id="${1#/noohub/devices/noohub_}"
            id="${id%%/*}"
            printf '%s\n' "$id"
            ;;
        *)
            printf '\n'
            ;;
    esac
}

noohub_device_allowed() {
    id="$1"

    if [ "$NOOHUB_SPRUTHUB_BLOCK_ALL" = "1" ]; then
        return 1
    fi

    if [ -z "$NOOHUB_SPRUTHUB_ALLOWED_IDS" ]; then
        return 0
    fi

    case " $NOOHUB_SPRUTHUB_ALLOWED_IDS " in
        *" $id "*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

normalize_command_payload() {
    case "$1" in
        1|true|TRUE|True|on|ON|On)
            printf '1\n'
            ;;
        0|false|FALSE|False|off|OFF|Off)
            printf '0\n'
            ;;
        SINGLE_PRESS|single_press)
            printf '1\n'
            ;;
        *)
            printf '\n'
            ;;
    esac
}

normalize_brightness_payload() {
    value="$(printf '%s\n' "$1" | sed 's/[^0-9.-].*$//')"

    case "$value" in
        ''|'.'|'-'|'-.' )
            printf '\n'
            return
            ;;
    esac

    value="$(awk -v v="$value" 'BEGIN {
        if (v < 0) v = 0;
        if (v > 100) v = 100;
        printf "%d", v + 0.5;
    }')"

    printf '%s\n' "$value"
}

control_name_from_command_topic() {
    topic="$1"
    topic="${topic#/noohub}"
    topic="${topic#/devices/noohub_}"
    topic="${topic#*/controls/}"
    topic="${topic%/on}"
    printf '%s\n' "$topic"
}

clear_retained_topic() {
    topic="$1"

    if [ -n "$topic" ]; then
        echo "Clear retained $topic" >> "$LOG"
        mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -n -t "$topic" 2>>"$LOG"
    fi
}

prune_noohub_retained_topics() {
    echo "Pruning retained NooHub topics before mirror start $(date)" >> "$LOG"

    mosquitto_sub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -W 1 -v \
        -t '/devices/#' -t '/noohub/devices/#' 2>>"$LOG" \
    | while IFS= read -r line; do
        topic="${line%% *}"

        case "$topic" in
            /devices/noohub_*)
                id="$(noohub_device_id_from_topic "$topic")"

                if [ -n "$id" ] && ! noohub_device_allowed "$id"; then
                    clear_retained_topic "$topic"
                fi
                ;;
            /noohub/devices/noohub_*)
                id="$(noohub_device_id_from_topic "$topic")"

                if [ "$NOOHUB_SPRUTHUB_MIRROR_LEGACY_PREFIX" != "1" ]; then
                    clear_retained_topic "$topic"
                elif [ -n "$id" ] && ! noohub_device_allowed "$id"; then
                    clear_retained_topic "$topic"
                fi
                ;;
        esac
    done
}

mirror_from_wb_to_noohub() {
    mosquitto_sub -h "$WB_MQTT_HOST" -p "$WB_MQTT_PORT" -v -t '/devices/#' 2>>"$LOG" | while IFS= read -r line; do
        topic="${line%% *}"

        if [ "$topic" = "$line" ]; then
            payload=""
        else
            payload="${line#* }"
        fi

        case "$topic" in
            /devices/noohub_*/controls/*/on)
                ;;
            /devices/noohub_*)
                id="$(noohub_device_id_from_topic "$topic")"

                if ! noohub_device_allowed "$id"; then
                    continue
                fi

                if [ -z "$payload" ]; then
                    mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -n -t "$topic" 2>>"$LOG"
                    if [ "$NOOHUB_SPRUTHUB_MIRROR_LEGACY_PREFIX" = "1" ]; then
                        mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -n -t "/noohub$topic" 2>>"$LOG"
                    fi
                else
                    mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -t "$topic" -m "$payload" 2>>"$LOG"
                    if [ "$NOOHUB_SPRUTHUB_MIRROR_LEGACY_PREFIX" = "1" ]; then
                        mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -t "/noohub$topic" -m "$payload" 2>>"$LOG"
                    fi
                fi
                ;;
        esac
    done
}

mirror_commands_from_noohub_to_wb() {
    mosquitto_sub -R -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -v -t '/devices/#' -t '/noohub/devices/#' 2>>"$LOG" | while IFS= read -r line; do
        topic="${line%% *}"

        if [ "$topic" = "$line" ]; then
            payload=""
        else
            payload="${line#* }"
        fi
        raw_payload="$payload"

        case "$topic" in
            /devices/noohub_*/controls/*/on|/noohub/devices/noohub_*/controls/*/on)
                id="$(noohub_device_id_from_topic "$topic")"
                control="$(control_name_from_command_topic "$topic")"

                if ! noohub_device_allowed "$id"; then
                    echo "Skip command for filtered device $topic" >> "$LOG"
                    continue
                fi

                if [ -z "$payload" ]; then
                    echo "Skip empty command $topic" >> "$LOG"
                    continue
                fi

                dst="${topic#/noohub}"
                case "$control" in
                    on|open|close|open_close|switch|pulse)
                        payload="$(normalize_command_payload "$payload")"
                        if [ -z "$payload" ]; then
                            echo "Unknown on command value: $topic payload=$raw_payload" >> "$LOG"
                            continue
                        fi
                        ;;
                    brightness|percent_open)
                        payload="$(normalize_brightness_payload "$payload")"
                        if [ -z "$payload" ]; then
                            echo "Unknown brightness command value: $topic payload=$raw_payload" >> "$LOG"
                            continue
                        fi
                        ;;
                    *)
                        echo "Forward raw command for $control: $topic payload=$payload" >> "$LOG"
                        ;;
                esac

                echo "Forward command $topic -> $dst payload=$payload" >> "$LOG"
                mosquitto_pub -h "$WB_MQTT_HOST" -p "$WB_MQTT_PORT" -t "$dst" -m "$payload" 2>>"$LOG"
                mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -n -t "$topic" 2>>"$LOG"
                ;;
        esac
    done
}

prune_noohub_retained_topics

while true; do
    mirror_from_wb_to_noohub
    echo "WB -> NooHub mirror loop restarted $(date)" >> "$LOG"
    sleep 2
done &

while true; do
    mirror_commands_from_noohub_to_wb
    echo "NooHub -> WB command loop restarted $(date)" >> "$LOG"
    sleep 2
done
