#!/bin/sh

LOG="/tmp/noohub_delete_virtual_devices.log"
DEVICES_FILE="/var/lib/wirenboard/noohub_bridge_devices.json"
TOPICS_FILE="/tmp/noohub_delete_topics.txt"
NOOHUB_TOPICS_FILE="/tmp/noohub_delete_spruthub_topics.txt"
IDS_FILE="/tmp/noohub_delete_ids.txt"
WB_MQTT_HOST="${WB_MQTT_HOST:-127.0.0.1}"
WB_MQTT_PORT="${WB_MQTT_PORT:-1883}"
NOOHUB_SPRUTHUB_MQTT_HOST="${NOOHUB_SPRUTHUB_MQTT_HOST:-127.0.0.1}"
NOOHUB_SPRUTHUB_MQTT_PORT="${NOOHUB_SPRUTHUB_MQTT_PORT:-45883}"
SETTINGS_STATUS_TOPIC="/devices/hoohub_bridge_setting/controls/status"

publish_status() {
    mosquitto_pub -h "$WB_MQTT_HOST" -p "$WB_MQTT_PORT" -r -t "$SETTINGS_STATUS_TOPIC" -m "$1" >> "$LOG" 2>&1
}

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

delete_main_topics_for_ids() {
    file="$1"

    if command -v mqtt-delete-retained >/dev/null 2>&1; then
        if [ -s "$IDS_FILE" ]; then
            while read id; do
                if [ -n "$id" ]; then
                    echo "mqtt-delete-retained /devices/noohub_$id/#" >> "$LOG"
                    mqtt-delete-retained "/devices/noohub_$id/#" >> "$LOG" 2>&1
                    mqtt-delete-retained "/devices/noohub_$id" >> "$LOG" 2>&1
                fi
            done < "$IDS_FILE"
            return
        fi
    fi

    if [ -s "$TOPICS_FILE" ]; then
        while read topic; do
            if [ -n "$topic" ]; then
                mosquitto_pub -r -n -t "$topic" >> "$LOG" 2>&1
            fi
        done < "$TOPICS_FILE"
    else
        echo "No /devices/noohub_* topics found" >> "$LOG"
    fi
}

echo "===== NooHub delete all started $(date) =====" > "$LOG"

echo "Collecting saved device IDs..." >> "$LOG"
rm -f "$IDS_FILE"

if [ -f "$DEVICES_FILE" ]; then
    grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "$DEVICES_FILE" 2>>"$LOG" \
    | sed 's/.*"id"[[:space:]]*:[[:space:]]*"//; s/"$//' \
    | awk 'NF {print $1}' \
    | sort -u > "$IDS_FILE"
fi

IDS_COUNT=$(wc -l < "$IDS_FILE" 2>/dev/null)
echo "Saved device IDs: $IDS_COUNT" >> "$LOG"

echo "Removing devices file..." >> "$LOG"
rm -f "$DEVICES_FILE" >> "$LOG" 2>&1

echo "Collecting retained MQTT topics /devices/noohub_* ..." >> "$LOG"

rm -f "$TOPICS_FILE"

echo "Main MQTT collect" >> "$LOG"
mosquitto_sub -W 1 -t '/devices/#' -v 2>>"$LOG" \
| awk '$1 ~ /^\/devices\/noohub_/ {print $1}' >> "$TOPICS_FILE"

if [ -s "$IDS_FILE" ]; then
    while read id; do
        if [ -n "$id" ]; then
            append_known_noohub_topics "$TOPICS_FILE" "/devices/noohub_$id"
        fi
    done < "$IDS_FILE"
fi

sort_topics_for_delete "$TOPICS_FILE"

COUNT=$(wc -l < "$TOPICS_FILE" 2>/dev/null)
echo "Found topics: $COUNT" >> "$LOG"

echo "Collecting retained MQTT topics on SprutHub MQTT ..." >> "$LOG"

rm -f "$NOOHUB_TOPICS_FILE"

echo "SprutHub MQTT collect" >> "$LOG"
mosquitto_sub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -W 1 -v \
    -t '/devices/#' -t '/noohub/devices/#' 2>>"$LOG" \
| awk '$1 ~ /^\/devices\/noohub_/ || $1 ~ /^\/noohub\/devices\/noohub_/ {print $1}' >> "$NOOHUB_TOPICS_FILE"

if [ -s "$IDS_FILE" ]; then
    while read id; do
        if [ -n "$id" ]; then
            append_known_noohub_topics "$NOOHUB_TOPICS_FILE" "/devices/noohub_$id"
            append_known_noohub_topics "$NOOHUB_TOPICS_FILE" "/noohub/devices/noohub_$id"
        fi
    done < "$IDS_FILE"
fi

sort_topics_for_delete "$NOOHUB_TOPICS_FILE"

NOOHUB_COUNT=$(wc -l < "$NOOHUB_TOPICS_FILE" 2>/dev/null)
echo "Found SprutHub topics: $NOOHUB_COUNT" >> "$LOG"

echo "Deleting all NooHub retained topics without wb-rules restart..." >> "$LOG"
delete_main_topics_for_ids "$TOPICS_FILE"

if [ -s "$NOOHUB_TOPICS_FILE" ]; then
    while read topic; do
        if [ -n "$topic" ]; then
            mosquitto_pub -h "$NOOHUB_SPRUTHUB_MQTT_HOST" -p "$NOOHUB_SPRUTHUB_MQTT_PORT" -r -n -t "$topic" >> "$LOG" 2>&1
        fi
    done < "$NOOHUB_TOPICS_FILE"
else
    echo "No /noohub/devices/noohub_* topics found" >> "$LOG"
fi

echo "===== NooHub delete all finished $(date) =====" >> "$LOG"
publish_status "delete all cleanup complete; refresh WB page if empty cards remain"

exit 0
