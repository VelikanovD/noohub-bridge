#!/bin/sh

LOG="/tmp/noohub_resync_selected_devices.log"
TOPICS_FILE="/tmp/noohub_resync_selected_topics.txt"
NOOHUB_TOPICS_FILE="/tmp/noohub_resync_selected_spruthub_topics.txt"
IDS_FILE="/tmp/noohub_resync_selected_ids.txt"
WB_MQTT_HOST="${WB_MQTT_HOST:-127.0.0.1}"
WB_MQTT_PORT="${WB_MQTT_PORT:-1883}"
NOOHUB_SPRUTHUB_MQTT_HOST="${NOOHUB_SPRUTHUB_MQTT_HOST:-127.0.0.1}"
NOOHUB_SPRUTHUB_MQTT_PORT="${NOOHUB_SPRUTHUB_MQTT_PORT:-45883}"
SETTINGS_STATUS_TOPIC="/devices/hoohub_bridge_setting/controls/status"
DELETE_MODE=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --delete-mode)
            DELETE_MODE=1
            shift
            ;;
        --)
            shift
            break
            ;;
        *)
            break
            ;;
    esac
done

append_known_noohub_topics() {
    file="$1"
    prefix="$2"

    {
        echo "$prefix"
        echo "$prefix/meta"
        echo "$prefix/meta/name"
        echo "$prefix/meta/room"
        echo "$prefix/meta/noohub_name"
        echo "$prefix/meta/noohub_room"
        echo "$prefix/meta/driver"
        echo "$prefix/meta/spruthub_type"
        echo "$prefix/meta/spruthub_template"
        for template in switch dimmer brightness rgb impulse cover open_close open_close_buttons; do
            echo "$prefix/meta/spruthub_template/$template"
        done
        echo "$prefix/controls"
        for control in on brightness pulse switch percent_open open_close pause open close speed_mode_switch switch_color overflow_color thermostat color spruthub_type info_id info_name info_room info_model info_type info_subtype info_protocol mtrf_ch noolite_mode retrievable reportable skills sensors events raw_json last_update status; do
            echo "$prefix/controls/$control"
            echo "$prefix/controls/$control/meta"
            echo "$prefix/controls/$control/on"
        done
    } >> "$file"
}

publish_status() {
    mosquitto_pub -h "$WB_MQTT_HOST" -p "$WB_MQTT_PORT" -r -t "$SETTINGS_STATUS_TOPIC" -m "$1" >> "$LOG" 2>&1
}

refresh_homeui_services() {
    echo "Refreshing WB Home UI services..." >> "$LOG"
    systemctl try-restart wb-mqtt-homeui.service >> "$LOG" 2>&1
    systemctl try-restart wb-mqtt-homeui-websocket.service >> "$LOG" 2>&1
    systemctl try-restart wb-homeui.service >> "$LOG" 2>&1
}

restart_wb_rules_after_cleanup() {
    echo "Restarting wb-rules after selected cleanup..." >> "$LOG"
    systemctl restart wb-rules >> "$LOG" 2>&1 || true

    sleep 2

    if systemctl is-active --quiet wb-rules; then
        echo "wb-rules is active after cleanup restart" >> "$LOG"
        return
    fi

    echo "wb-rules is not active, trying one more restart..." >> "$LOG"
    systemctl restart wb-rules >> "$LOG" 2>&1 || true

    sleep 2

    if systemctl is-active --quiet wb-rules; then
        echo "wb-rules is active after retry" >> "$LOG"
    else
        echo "wb-rules is still not active after retry" >> "$LOG"
    fi
}

sort_topics_for_delete() {
    file="$1"

    if [ ! -s "$file" ]; then
        return
    fi

    tmp="${file}.sorted"
    sort -u "$file" \
    | awk '{s=$0; depth=gsub(/\//, "/", s); print depth " " $0}' \
    | sort -rn \
    | cut -d' ' -f2- > "$tmp" 2>/dev/null
    mv "$tmp" "$file"
}

delete_main_topics() {
    file="$1"

    if [ ! -s "$file" ]; then
        echo "No selected /devices/noohub_* topics found" >> "$LOG"
        return
    fi

    if [ "$DELETE_MODE" = "1" ]; then
        while read topic; do
            if [ -n "$topic" ]; then
                mosquitto_pub -r -n -t "$topic" >> "$LOG" 2>&1
            fi
        done < "$file"
    else
        xargs -r -n 8 -P 4 sh -c 'for topic do mosquitto_pub -r -n -t "$topic"; done' sh < "$file" >> "$LOG" 2>&1
    fi
}

delete_main_topics_for_ids() {
    file="$1"

    if command -v mqtt-delete-retained >/dev/null 2>&1; then
        while read id; do
            if [ -n "$id" ]; then
                echo "mqtt-delete-retained /devices/noohub_$id/#" >> "$LOG"
                mqtt-delete-retained "/devices/noohub_$id/#" >> "$LOG" 2>&1
                mqtt-delete-retained "/devices/noohub_$id" >> "$LOG" 2>&1
            fi
        done < "$IDS_FILE"
    else
        delete_main_topics "$file"
    fi
}

delete_spruthub_topics() {
    file="$1"

    if [ ! -s "$file" ]; then
        echo "No selected SprutHub topics found" >> "$LOG"
        return
    fi

    if [ "$DELETE_MODE" = "1" ]; then
        while read topic; do
            if [ -n "$topic" ]; then
                mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -n -t "$topic" >> "$LOG" 2>&1
            fi
        done < "$file"
    else
        xargs -r -n 8 -P 4 sh -c 'host="$1"; port="$2"; shift 2; for topic do mosquitto_pub -h "$host" -p "$port" -r -n -t "$topic"; done' sh "$NOOHUB_SPRUTHUB_MQTT_HOST" "$NOOHUB_SPRUTHUB_MQTT_PORT" < "$file" >> "$LOG" 2>&1
    fi
}

echo "===== NooHub selected cleanup started $(date) =====" > "$LOG"
echo "Delete mode: $DELETE_MODE" >> "$LOG"
echo "Device IDs: $*" >> "$LOG"

if [ "$#" -eq 0 ]; then
    echo "No device IDs provided" >> "$LOG"
    if [ "$DELETE_MODE" = "1" ]; then
        publish_status "delete CH cleanup skipped: no channels selected"
    else
        publish_status "resync cleanup skipped: no channels selected"
    fi
    exit 0
fi

if [ "$DELETE_MODE" != "1" ]; then
    echo "Stopping wb-rules..." >> "$LOG"
    systemctl stop wb-rules >> "$LOG" 2>&1
fi

rm -f "$TOPICS_FILE"
rm -f "$NOOHUB_TOPICS_FILE"
rm -f "$IDS_FILE"

for id in "$@"; do
    if [ -z "$id" ]; then
        continue
    fi

    echo "$id" >> "$IDS_FILE"
done

sort -u "$IDS_FILE" -o "$IDS_FILE" 2>/dev/null

if [ ! -s "$IDS_FILE" ]; then
    echo "No non-empty device IDs provided" >> "$LOG"
    if [ "$DELETE_MODE" != "1" ]; then
        systemctl start wb-rules >> "$LOG" 2>&1
        publish_status "resync cleanup skipped: no channels selected"
    else
        publish_status "delete CH cleanup skipped: no channels selected"
    fi
    exit 0
fi

if [ "$DELETE_MODE" != "1" ]; then
    echo "Collecting main MQTT topics for selected IDs..." >> "$LOG"
    mosquitto_sub -W 1 -t '/devices/#' -v 2>>"$LOG" \
    | awk -v ids_file="$IDS_FILE" '
    BEGIN {
        while ((getline id < ids_file) > 0) {
            if (id != "") {
                wanted[id] = 1
            }
        }
    }
    {
        topic = $1
        id = ""
        if (topic ~ /^\/devices\/noohub_/) {
            id = topic
            sub(/^\/devices\/noohub_/, "", id)
            sub(/\/.*/, "", id)
        }
        if (id != "" && wanted[id]) {
            print topic
        }
    }
' >> "$TOPICS_FILE"
else
    echo "Delete mode: skip retained topic scan on main MQTT" >> "$LOG"
fi

if [ "$DELETE_MODE" != "1" ]; then
    echo "Collecting SprutHub MQTT topics for selected IDs..." >> "$LOG"
    mosquitto_sub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -W 1 -v \
        -t '/devices/#' -t '/noohub/devices/#' 2>>"$LOG" \
    | awk -v ids_file="$IDS_FILE" '
    BEGIN {
        while ((getline id < ids_file) > 0) {
            if (id != "") {
                wanted[id] = 1
            }
        }
    }
    {
        topic = $1
        id = ""
        if (topic ~ /^\/devices\/noohub_/) {
            id = topic
            sub(/^\/devices\/noohub_/, "", id)
            sub(/\/.*/, "", id)
        } else if (topic ~ /^\/noohub\/devices\/noohub_/) {
            id = topic
            sub(/^\/noohub\/devices\/noohub_/, "", id)
            sub(/\/.*/, "", id)
        }
        if (id != "" && wanted[id]) {
            print topic
        }
    }
' >> "$NOOHUB_TOPICS_FILE"
else
    echo "Delete mode: skip retained topic scan on SprutHub MQTT" >> "$LOG"
fi

while read id; do
    if [ -z "$id" ]; then
        continue
    fi

    prefix="/devices/noohub_$id"

    append_known_noohub_topics "$TOPICS_FILE" "$prefix"

    noohub_prefix="/noohub/devices/noohub_$id"
    spruthub_devices_prefix="/devices/noohub_$id"

    append_known_noohub_topics "$NOOHUB_TOPICS_FILE" "$spruthub_devices_prefix"
    append_known_noohub_topics "$NOOHUB_TOPICS_FILE" "$noohub_prefix"
done < "$IDS_FILE"

sort_topics_for_delete "$TOPICS_FILE"
sort_topics_for_delete "$NOOHUB_TOPICS_FILE"

COUNT=$(wc -l < "$TOPICS_FILE" 2>/dev/null)
echo "Found selected topics: $COUNT" >> "$LOG"

NOOHUB_COUNT=$(wc -l < "$NOOHUB_TOPICS_FILE" 2>/dev/null)
echo "Found selected SprutHub topics: $NOOHUB_COUNT" >> "$LOG"

if [ "$DELETE_MODE" = "1" ]; then
    echo "Deleting selected retained topics without wb-rules restart..." >> "$LOG"
    delete_main_topics_for_ids "$TOPICS_FILE"
    delete_spruthub_topics "$NOOHUB_TOPICS_FILE"
else
    delete_main_topics "$TOPICS_FILE"
    delete_spruthub_topics "$NOOHUB_TOPICS_FILE"
    restart_wb_rules_after_cleanup
fi

if [ "$DELETE_MODE" != "1" ]; then
    sleep 2
    refresh_homeui_services
fi

echo "===== NooHub selected cleanup finished $(date) =====" >> "$LOG"
if [ "$DELETE_MODE" = "1" ]; then
    publish_status "delete CH cleanup complete; refresh WB page if empty cards remain"
else
    publish_status "resync cleanup complete"
fi

exit 0
