// /etc/wb-rules/noohub_bridge.js
// Wiren Board ↔ NooHub ↔ NooLite bridge
// NooHub HTTP API + Digest auth
//
// Safe architecture:
// - Sync / Scan Devices updates information only, does not delete cards
// - Resync CH in bridge settings recreates only one card by NooLite CH
// - Delete Virtual Devices fully removes all noohub_* cards through external script
// - clear_devices_list removed intentionally

var NOOHUB_CONFIG_FILE = "/var/lib/wirenboard/noohub_bridge_config.json";
var NOOHUB_DEVICES_FILE = "/var/lib/wirenboard/noohub_bridge_devices.json";

var NOOHUB_DELETE_SCRIPT = "/usr/local/bin/noohub_delete_virtual_devices.sh";
var NOOHUB_RESYNC_SELECTED_SCRIPT = "/usr/local/bin/noohub_resync_selected_devices.sh";
var NOOHUB_SPRUTHUB_MQTT_CONF = "/etc/mosquitto/noohub_spruthub_mosquitto.conf";
var NOOHUB_SPRUTHUB_MQTT_PROXY_ENV = "/etc/default/noohub_spruthub_mqtt_proxy";
var NOOHUB_SPRUTHUB_LEGACY_LISTENER_CONF = "/etc/mosquitto/conf.d/noohub_spruthub_mqtt_listener.conf";

var NOOHUB_SETTINGS_DEVICE = "hoohub_bridge_setting";

var noohubIp = "192.168.0.62";
var noohubId = "f01c5394c9";
var noohubApiUrl = "http://192.168.0.62/api";
var noohubGetDevicesType = "blocks";
var NOOHUB_SPRUTHUB_MQTT_DEFAULT_PORT = 45883;
var noohubSprutHubMqttPort = NOOHUB_SPRUTHUB_MQTT_DEFAULT_PORT;
var noohubSprutHubMqttPortApplied = NOOHUB_SPRUTHUB_MQTT_DEFAULT_PORT;
var noohubSprutHubChFilter = "";

var NOOHUB_DEVICE_INFO_FIELDS = [
    { name: "info_id", title: "Show NooHub ID" },
    { name: "info_name", title: "Show Name" },
    { name: "info_room", title: "Show Room" },
    { name: "info_model", title: "Show Model" },
    { name: "info_type", title: "Show Type" },
    { name: "info_subtype", title: "Show Subtype" },
    { name: "info_protocol", title: "Show Protocol" },
    { name: "mtrf_ch", title: "Show MTRF CH" },
    { name: "noolite_mode", title: "Show NooLite Mode" },
    { name: "retrievable", title: "Show Retrievable" },
    { name: "reportable", title: "Show Reportable" },
    { name: "skills", title: "Show Skills" },
    { name: "sensors", title: "Show Sensors" },
    { name: "events", title: "Show Events" },
    { name: "raw_json", title: "Show Raw JSON" }
];

var NOOHUB_SPRUTHUB_TEMPLATE_TYPES = [
    "switch",
    "dimmer",
    "impulse",
    "brightness",
    "rgb",
    "cover",
    "open_close",
    "open_close_buttons"
];

var noohubDeviceInfoVisible = {};

var NOOHUB_SUPPORTED_SKILLS = [
    "on",
    "switch",
    "brightness",
    "percent_open",
    "thermostat",
    "color",
    "switch_color",
    "overflow_color",
    "speed_mode_switch",
    "pause",
    "open",
    "close",
    "open_close",
    "pulse"
];

var NOOHUB_CURL_CONNECT_TIMEOUT_SEC = 3;
var NOOHUB_CURL_MAX_TIME_SEC = 10;
var NOOHUB_COMMAND_CURL_CONNECT_TIMEOUT_SEC = 2;
var NOOHUB_COMMAND_CURL_MAX_TIME_SEC = 5;

var noohubAuthEnabled = true;
var noohubUsername = "admin";
var noohubPasswordPlain = "";
var noohubPasswordEnc = "";

var noohubDevices = [];
var noohubDeviceById = {};
var noohubCreatedDevices = {};

var noohubSettingsLoading = false;
var noohubPollingBusy = false;
var noohubPollingBusyStartedAt = 0;
var noohubPollCancelRequested = false;
var NOOHUB_POLLING_BUSY_TIMEOUT_MS = 180000;
var NOOHUB_POLLING_TICK_MS = 200;
var NOOHUB_POLL_PROTECTION_SAFE_INTERVAL_SEC = 5;
var NOOHUB_POLL_PROTECTION_BUSY_SKIP_LIMIT = 15;
var NOOHUB_POLL_PROTECTION_SLOW_LIMIT = 3;
var NOOHUB_POLL_PROTECTION_COOLDOWN_MS = 60000;
var noohubPollBusySkipCount = 0;
var noohubPollSlowCount = 0;
var noohubPollProtectionLastAt = 0;
var noohubNoPollUntil = 0;
var NOOHUB_COMMAND_POLL_PAUSE_MS = 5000;
var NOOHUB_SET_STATE_POLLING_DELAY_MS = 700;
var NOOHUB_SET_STATE_RETRY_DELAY_MS = 900;
var NOOHUB_SET_STATE_MAX_ATTEMPTS = 3;
var NOOHUB_STARTUP_RESET_DELAY_MS = 3000;
var NOOHUB_STARTUP_RESET_STEP_MS = 500;
var noohubScanBusy = false;
var noohubScanBusyStartedAt = 0;
var NOOHUB_SCAN_BUSY_TIMEOUT_MS = 120000;
var noohubDeleteBusyUntil = 0;

var noohubUpdatingFromPoll = false;
var noohubUpdatingFromPollStartedAt = 0;
var NOOHUB_UPDATING_FROM_POLL_TIMEOUT_MS = 5000;


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function noohubLog(msg) {
    log("NooHub: " + msg);
}

function noohubMaskSensitive(cmd) {
    if (!cmd) {
        return "";
    }

    var s = String(cmd);

    s = s.replace(/-u '[^']*'/g, "-u '***:***'");
    s = s.replace(/printf %s '[^']*' \| openssl enc -aes-256-cbc/g, "printf %s '***' | openssl enc -aes-256-cbc");

    return s;
}

function noohubShellQuote(s) {
    if (s === null || s === undefined) {
        s = "";
    }

    s = String(s);
    return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function noohubIsButtonPressed(value) {
    return value === true ||
        value === 1 ||
        value === "1" ||
        String(value).toLowerCase() === "true" ||
        String(value).toLowerCase() === "on";
}

function noohubRun(cmd, callback, quiet) {
    if (!quiet) {
        noohubLog("CMD: " + noohubMaskSensitive(cmd));
    }

    runShellCommand(cmd, {
        captureOutput: true,
        exitCallback: function(exitCode, capturedOutput) {
            if (capturedOutput === null || capturedOutput === undefined) {
                capturedOutput = "";
            }

            if (callback) {
                callback(exitCode, String(capturedOutput));
            }
        }
    });
}

function noohubReadFile(path, callback) {
    var cmd = "if [ -f " + noohubShellQuote(path) + " ]; then cat " + noohubShellQuote(path) + "; fi";

    noohubRun(cmd, function(exitCode, output) {
        callback(output || "");
    });
}

function noohubWriteFile(path, content, callback) {
    var dir = path.replace(/\/[^\/]+$/, "");

    var cmd =
        "mkdir -p " + noohubShellQuote(dir) +
        " && printf %s " + noohubShellQuote(content) +
        " > " + noohubShellQuote(path);

    noohubRun(cmd, function(exitCode, output) {
        if (callback) {
            callback(exitCode === 0);
        }
    });
}

function noohubNowString() {
    var d = new Date();

    function pad(n) {
        return n < 10 ? "0" + n : "" + n;
    }

    return d.getFullYear() + "-" +
        pad(d.getMonth() + 1) + "-" +
        pad(d.getDate()) + " " +
        pad(d.getHours()) + ":" +
        pad(d.getMinutes()) + ":" +
        pad(d.getSeconds());
}

function noohubSafeJsonParse(raw, where) {
    if (!raw || String(raw).trim() === "") {
        noohubLog(where + ": empty JSON");
        return null;
    }

    raw = String(raw).trim();

    try {
        return JSON.parse(raw);
    } catch (e) {
        noohubLog(where + ": JSON parse error: " + e);
        noohubLog(where + ": bad raw response: " + raw.substr(0, 500));
        return null;
    }
}

function noohubShortRawForStatus(raw) {
    var s = String(raw || "").replace(/\s+/g, " ");

    if (s.length > 120) {
        s = s.substr(0, 120);
    }

    return s || "empty response";
}

function noohubIsGoodDevicesResponse(resp) {
    return !!resp && (resp.success === true || Array.isArray(resp.devices));
}

function noohubIsGoodStateResponse(resp) {
    return !!resp && (resp.success === true || Array.isArray(resp.devices) || resp.state !== undefined);
}

function noohubDevicesResponseErrorText(raw) {
    return "bad get_devices: " + noohubShortRawForStatus(raw);
}

function noohubSetStatus(text) {
    dev[NOOHUB_SETTINGS_DEVICE + "/status"] = String(text);
    noohubLog(String(text));
}

function noohubSetDevIfChanged(path, value) {
    if (dev[path] !== value) {
        dev[path] = value;
        return true;
    }

    return false;
}

function noohubSetUpdatingFromPoll(value) {
    noohubUpdatingFromPoll = !!value;
    noohubUpdatingFromPollStartedAt = value ? new Date().getTime() : 0;
}

function noohubFinishPolling(statusText) {
    var finishedAt = new Date().getTime();
    var durationMs = noohubPollingBusyStartedAt ? finishedAt - noohubPollingBusyStartedAt : 0;

    noohubPollingBusy = false;
    noohubPollingBusyStartedAt = 0;
    noohubPollCancelRequested = false;
    noohubPollBusySkipCount = 0;
    dev[NOOHUB_SETTINGS_DEVICE + "/last_poll"] = noohubNowString();
    noohubSetStatus(statusText || "poll complete");

    if (String(statusText || "").indexOf("poll stopped") !== 0) {
        noohubRecordPollDuration(durationMs);
    }
}

function noohubMarkCommandActivity() {
    noohubNoPollUntil = new Date().getTime() + NOOHUB_COMMAND_POLL_PAUSE_MS;

    if (noohubPollingBusy) {
        noohubPollCancelRequested = true;
    }
}

function noohubCommandPauseRemainingMs() {
    var left = noohubNoPollUntil - new Date().getTime();
    return left > 0 ? left : 0;
}

function noohubCurrentPollInterval() {
    return noohubNormalizePollInterval(dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"]);
}

function noohubRetrievableDeviceCount() {
    var count = 0;

    for (var i = 0; i < noohubDevices.length; i++) {
        if (noohubDevices[i] && noohubDevices[i].id && noohubDevices[i].retrievable === true) {
            count++;
        }
    }

    return count;
}

function noohubDynamicPollingBusyTimeoutMs() {
    var retrievableCount = noohubRetrievableDeviceCount();
    var perDeviceMs = (NOOHUB_CURL_MAX_TIME_SEC + 1) * 1000;

    return Math.max(NOOHUB_POLLING_BUSY_TIMEOUT_MS, retrievableCount * perDeviceMs + 30000);
}

function noohubProtectPolling(reason) {
    var now = new Date().getTime();
    var currentInterval = noohubCurrentPollInterval();

    if (currentInterval >= NOOHUB_POLL_PROTECTION_SAFE_INTERVAL_SEC) {
        return false;
    }

    if (noohubPollProtectionLastAt &&
        now - noohubPollProtectionLastAt < NOOHUB_POLL_PROTECTION_COOLDOWN_MS) {
        return false;
    }

    noohubPollProtectionLastAt = now;
    noohubPollBusySkipCount = 0;
    noohubPollSlowCount = 0;
    dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"] = NOOHUB_POLL_PROTECTION_SAFE_INTERVAL_SEC;
    noohubPollingTick.lastRun = now;
    noohubSaveSettings(true);
    noohubSetStatus("poll protection: " + reason + ", interval raised to " + NOOHUB_POLL_PROTECTION_SAFE_INTERVAL_SEC + " sec");

    return true;
}

function noohubRecordPollBusySkip(reason) {
    noohubPollBusySkipCount++;

    if (noohubPollBusySkipCount >= NOOHUB_POLL_PROTECTION_BUSY_SKIP_LIMIT) {
        noohubProtectPolling(reason || "poll is still running");
    }
}

function noohubRecordPollDuration(durationMs) {
    if (!durationMs || durationMs <= 0) {
        return;
    }

    var currentInterval = noohubCurrentPollInterval();

    if (currentInterval >= NOOHUB_POLL_PROTECTION_SAFE_INTERVAL_SEC) {
        noohubPollSlowCount = 0;
        return;
    }

    if (durationMs > Math.max(1500, currentInterval * 1000)) {
        noohubPollSlowCount++;

        if (noohubPollSlowCount >= NOOHUB_POLL_PROTECTION_SLOW_LIMIT) {
            noohubProtectPolling("poll cycle is slower than interval");
        }

        return;
    }

    noohubPollSlowCount = 0;
}

function noohubIsDeviceBusyResponse(resp, raw) {
    if (resp && resp.success === false &&
        (resp.message === "device_busy" || resp.busy_type === "http")) {
        return true;
    }

    return String(raw || "").indexOf("device_busy") >= 0;
}

function noohubIsUpdatingFromPoll() {
    if (!noohubUpdatingFromPoll) {
        return false;
    }

    var now = new Date().getTime();

    if (noohubUpdatingFromPollStartedAt &&
        now - noohubUpdatingFromPollStartedAt > NOOHUB_UPDATING_FROM_POLL_TIMEOUT_MS) {
        noohubSetUpdatingFromPoll(false);
        noohubLog("poll update flag reset by watchdog");
        return false;
    }

    return true;
}

function noohubSetPasswordStatus() {
    if (noohubPasswordPlain || noohubPasswordEnc) {
        dev[NOOHUB_SETTINGS_DEVICE + "/noohub_password_status"] = "saved";
    } else {
        dev[NOOHUB_SETTINGS_DEVICE + "/noohub_password_status"] = "empty";
    }
}

function noohubUpdateApiUrlFromIp() {
    noohubIp = String(dev[NOOHUB_SETTINGS_DEVICE + "/noohub_ip"] || noohubIp);
    noohubApiUrl = "http://" + noohubIp + "/api";
    dev[NOOHUB_SETTINGS_DEVICE + "/api_url"] = noohubApiUrl;
}

function noohubNormalizeGetDevicesType(value) {
    var t = String(value || "blocks").replace(/\s+/g, "");

    if (t !== "all" && t !== "blocks" && t !== "sensors" && t !== "remotes") {
        t = "blocks";
    }

    return t;
}

function noohubNormalizeSprutHubMqttPort(value) {
    var p = parseInt(value, 10);

    if (isNaN(p) || p < 1024 || p > 65535) {
        p = NOOHUB_SPRUTHUB_MQTT_DEFAULT_PORT;
    }

    return p;
}

function noohubNormalizePollInterval(value) {
    var interval = parseFloat(String(value).replace(",", "."));

    if (isNaN(interval) || interval < 1) {
        interval = 1;
    }

    if (interval > 180) {
        interval = 180;
    }

    return Math.round(interval * 10) / 10;
}

function noohubUpdateGetDevicesTypeFromControl() {
    noohubGetDevicesType = noohubNormalizeGetDevicesType(
        dev[NOOHUB_SETTINGS_DEVICE + "/get_devices_type"] || noohubGetDevicesType
    );

    if (dev[NOOHUB_SETTINGS_DEVICE + "/get_devices_type"] !== undefined) {
        dev[NOOHUB_SETTINGS_DEVICE + "/get_devices_type"] = noohubGetDevicesType;
    }
}

function noohubBuildGetDevicesRequest() {
    noohubUpdateGetDevicesTypeFromControl();

    var req = {
        action: "get_devices"
    };

    if (noohubGetDevicesType && noohubGetDevicesType !== "all") {
        req.type = noohubGetDevicesType;
    }

    return req;
}

function noohubBuildGetAllDevicesRequest() {
    return {
        action: "get_devices"
    };
}

function noohubNooliteModeText(mode) {
    if (mode === undefined || mode === null || mode === "") {
        return "";
    }

    var m = parseInt(mode, 10);

    if (m === 0) {
        return "0 — NooLite TX";
    }

    if (m === 1) {
        return "1 — NooLite RX";
    }

    if (m === 2) {
        return "2 — NooLite F-TX";
    }

    return String(mode);
}

function noohubNormalizeText(s) {
    if (s === null || s === undefined) {
        return "";
    }

    return String(s);
}

function noohubBoolValue(v) {
    if (v === true || v === 1 || v === "1" || v === "true") {
        return true;
    }

    return false;
}

function noohubMqttValueToOn(value) {
    var v = String(value).replace(/^\s+|\s+$/g, "").toLowerCase();

    if (value === true || value === 1 || v === "1" || v === "true" || v === "on") {
        return 1;
    }

    if (value === false || value === 0 || v === "0" || v === "false" || v === "off") {
        return 0;
    }

    return null;
}

function noohubStripBridgeFields(obj) {
    var out = {};
    var skip = {
        skills_text: true,
        sensors_text: true,
        events_text: true,
        controls: true,
        raw_json: true,
        noolite_mode_text: true
    };

    if (!obj) {
        return out;
    }

    for (var k in obj) {
        if (!obj.hasOwnProperty(k)) {
            continue;
        }

        if (skip[k]) {
            continue;
        }

        out[k] = obj[k];
    }

    return out;
}

function noohubRawJsonSource(d) {
    var src = d || {};

    // If the device was loaded from our saved file, raw_json can already exist.
    // Use the deepest saved original NooHub object and remove bridge-only fields,
    // otherwise Raw JSON becomes recursively nested after every restart/scan.
    for (var i = 0; i < 8; i++) {
        if (!src || src.raw_json === undefined) {
            break;
        }

        if (typeof src.raw_json !== "string") {
            break;
        }

        var parsed = noohubSafeJsonParse(src.raw_json, "raw_json cleanup");

        if (!parsed) {
            break;
        }

        src = parsed;
    }

    return noohubStripBridgeFields(src);
}

function noohubRawJson(d) {
    try {
        return JSON.stringify(noohubRawJsonSource(d));
    } catch (e) {
        return "{}";
    }
}

function noohubClearMemory() {
    noohubDevices = [];
    noohubDeviceById = {};
    noohubCreatedDevices = {};
    dev[NOOHUB_SETTINGS_DEVICE + "/devices_count"] = 0;
}

function noohubDeviceInfoSettingName(name) {
    return "show_device_" + name;
}

function noohubInitDeviceInfoVisibilityDefaults() {
    for (var i = 0; i < NOOHUB_DEVICE_INFO_FIELDS.length; i++) {
        noohubDeviceInfoVisible[NOOHUB_DEVICE_INFO_FIELDS[i].name] = true;
    }
}

function noohubIsDeviceInfoVisible(name) {
    return noohubDeviceInfoVisible[name] !== false;
}

function noohubApplyDeviceInfoVisibilityConfig(map) {
    if (!map) {
        return;
    }

    for (var i = 0; i < NOOHUB_DEVICE_INFO_FIELDS.length; i++) {
        var name = NOOHUB_DEVICE_INFO_FIELDS[i].name;

        if (map[name] !== undefined) {
            noohubDeviceInfoVisible[name] = !!map[name];
        }
    }
}

function noohubDeviceInfoVisibilityConfig() {
    var out = {};

    for (var i = 0; i < NOOHUB_DEVICE_INFO_FIELDS.length; i++) {
        var name = NOOHUB_DEVICE_INFO_FIELDS[i].name;
        out[name] = noohubIsDeviceInfoVisible(name);
    }

    return out;
}

function noohubSyncDeviceInfoVisibilityControls() {
    for (var i = 0; i < NOOHUB_DEVICE_INFO_FIELDS.length; i++) {
        var name = NOOHUB_DEVICE_INFO_FIELDS[i].name;
        var control = noohubDeviceInfoSettingName(name);

        if (dev[NOOHUB_SETTINGS_DEVICE + "/" + control] !== undefined) {
            dev[NOOHUB_SETTINGS_DEVICE + "/" + control] = noohubIsDeviceInfoVisible(name);
        }
    }
}

function noohubUpdateDeviceInfoVisibilityFromControls() {
    for (var i = 0; i < NOOHUB_DEVICE_INFO_FIELDS.length; i++) {
        var name = NOOHUB_DEVICE_INFO_FIELDS[i].name;
        var control = noohubDeviceInfoSettingName(name);

        if (dev[NOOHUB_SETTINGS_DEVICE + "/" + control] !== undefined) {
            noohubDeviceInfoVisible[name] = !!dev[NOOHUB_SETTINGS_DEVICE + "/" + control];
        }
    }
}

noohubInitDeviceInfoVisibilityDefaults();


// -----------------------------------------------------------------------------
// Scan busy protection
// -----------------------------------------------------------------------------

function noohubIsScanBusyExpired() {
    if (!noohubScanBusy) {
        return false;
    }

    if (!noohubScanBusyStartedAt) {
        return true;
    }

    var now = new Date().getTime();

    return now - noohubScanBusyStartedAt > NOOHUB_SCAN_BUSY_TIMEOUT_MS;
}

function noohubResetScanBusy(reason) {
    noohubScanBusy = false;
    noohubScanBusyStartedAt = 0;

    noohubLog("sync busy reset: " + reason);
}

function noohubResetRuntimeLocks(reason) {
    noohubPollingBusy = false;
    noohubPollingBusyStartedAt = 0;
    noohubPollCancelRequested = false;
    noohubPollBusySkipCount = 0;
    noohubPollSlowCount = 0;
    noohubScanBusy = false;
    noohubScanBusyStartedAt = 0;
    noohubDeleteBusyUntil = 0;
    noohubSetUpdatingFromPoll(false);
    noohubSetStatus("runtime locks reset: " + (reason || "manual"));
}


// -----------------------------------------------------------------------------
// Skills / controls helpers
// -----------------------------------------------------------------------------

function noohubArrayContainsSkill(skills, skillName) {
    if (!skills) {
        return false;
    }

    for (var i = 0; i < skills.length; i++) {
        var s = skills[i];

        if (typeof s === "string" && s === skillName) {
            return true;
        }

        if (typeof s === "object" && s !== null) {
            if (s.name === skillName) {
                return true;
            }

            if (s.skill === skillName) {
                return true;
            }

            if (s.type === skillName) {
                return true;
            }

            if (s[skillName] !== undefined) {
                return true;
            }
        }
    }

    return false;
}

function noohubNormalizeSkillListWithKnown(skills) {
    var map = {};
    var out = noohubNormalizeSkills(skills);

    for (var i = 0; i < out.length; i++) {
        map[out[i]] = true;
    }

    for (var j = 0; j < NOOHUB_SUPPORTED_SKILLS.length; j++) {
        var skill = NOOHUB_SUPPORTED_SKILLS[j];

        if (noohubArrayContainsSkill(skills, skill) && !map[skill]) {
            map[skill] = true;
            out.push(skill);
        }
    }

    out.sort();
    return out;
}

function noohubListText(list) {
    return noohubNormalizeSkillListWithKnown(list).join(", ");
}

function noohubNormalizeControls(controls) {
    var map = {};
    var out = [];

    if (!controls) {
        return out;
    }

    for (var i = 0; i < controls.length; i++) {
        var c = String(controls[i] || "");

        if (!c) {
            continue;
        }

        if (!map[c]) {
            map[c] = true;
            out.push(c);
        }
    }

    out.sort();
    return out;
}

function noohubNormalizeSkills(skills) {
    var out = [];

    if (!skills) {
        return out;
    }

    for (var i = 0; i < skills.length; i++) {
        var s = skills[i];

        if (typeof s === "string") {
            out.push(s);
        } else {
            try {
                out.push(JSON.stringify(s));
            } catch (e) {
                out.push(String(s));
            }
        }
    }

    out.sort();
    return out;
}

function noohubSkillsText(skills) {
    return noohubListText(skills);
}

function noohubIsCommandButtonDevice(d) {
    if (!d) {
        return false;
    }

    var model = String(d.model || "").toLowerCase();

    // Only explicit Impulse models must be displayed as a pushbutton.
    // noolite_mode=0 alone can also describe regular TX devices, including dimmers.
    if (model.indexOf("impulse") >= 0) {
        return true;
    }

    return false;
}

function noohubShouldUseSwitchCardForLocalState(d) {
    return !!(d && d.id && d.retrievable !== true);
}

function noohubShouldUseOnButtonControl(d) {
    return noohubIsCommandButtonDevice(d) && !noohubShouldUseSwitchCardForLocalState(d);
}

function noohubDeviceTextForTypeDetect(d) {
    if (!d) {
        return "";
    }

    return [
        d.name,
        d.room,
        d.model,
        d.type,
        d.subtype,
        d.skills_text,
        d.raw_json
    ].join(" ").toLowerCase();
}

function noohubDeviceLabelTextForTypeDetect(d) {
    if (!d) {
        return "";
    }

    return [
        d.name,
        d.room,
        d.model,
        d.type,
        d.subtype,
        d.protocol
    ].join(" ").toLowerCase();
}

function noohubLooksLikeCoverDevice(d) {
    var text = noohubDeviceTextForTypeDetect(d);

    return /cover|curtain|blind|shade|shutter|jalousie|roller|window_cover|штор|жалюз|роллет|ставн/.test(text);
}

function noohubLooksLikeOpenCloseDevice(d) {
    var text = noohubDeviceLabelTextForTypeDetect(d);

    return /open[ _-]*close|contact|reed|door|window|magnet|датчик\s*откр|геркон|двер|окн|откр.*закр/.test(text);
}

function noohubGetControlsForDevice(d) {
    var controls = [];
    var skills = d.skills || [];

    if (noohubArrayContainsSkill(skills, "on")) {
        if (noohubShouldUseOnButtonControl(d)) {
            controls.push("on_button");
        } else {
            controls.push("on");
        }
    }

    if (noohubArrayContainsSkill(skills, "switch")) {
        controls.push("switch");
    }

    if (noohubArrayContainsSkill(skills, "brightness")) {
        controls.push("brightness");
    }

    if (noohubArrayContainsSkill(skills, "percent_open") && noohubLooksLikeCoverDevice(d)) {
        controls.push("percent_open");
    }

    if (noohubArrayContainsSkill(skills, "thermostat")) {
        controls.push("thermostat");
    }

    if (noohubArrayContainsSkill(skills, "color")) {
        controls.push("color");
    }

    if (noohubArrayContainsSkill(skills, "switch_color")) {
        controls.push("switch_color");
    }

    if (noohubArrayContainsSkill(skills, "overflow_color")) {
        controls.push("overflow_color");
    }

    if (noohubArrayContainsSkill(skills, "speed_mode_switch")) {
        controls.push("speed_mode_switch");
    }

    if (noohubArrayContainsSkill(skills, "pause")) {
        controls.push("pause");
    }

    if (noohubArrayContainsSkill(skills, "open")) {
        controls.push("open");
    }

    if (noohubArrayContainsSkill(skills, "close")) {
        controls.push("close");
    }

    if (noohubArrayContainsSkill(skills, "open_close") && noohubLooksLikeOpenCloseDevice(d)) {
        controls.push("open_close");
    }

    if (noohubArrayContainsSkill(skills, "pulse")) {
        controls.push("pulse");
    }

    if (controls.length === 0 && d.type === "block") {
        controls.push(noohubShouldUseOnButtonControl(d) ? "on_button" : "on");
    }

    return noohubNormalizeControls(controls);
}

function noohubControlsKey(controls) {
    return noohubNormalizeControls(controls).join("|");
}

function noohubCarryDeviceOverrides(newDevice, oldDevice) {
    if (!newDevice || !oldDevice) {
        return newDevice;
    }

    return newDevice;
}

function noohubNormalizeDevice(d) {
    var nd = {};

    if (!d) {
        d = {};
    }

    nd.id = noohubNormalizeText(d.id);
    nd.name = noohubNormalizeText(d.name || d.title || d.id || "NooHub device");
    nd.room = noohubNormalizeText(d.room || "");
    nd.model = noohubNormalizeText(d.model || "");
    nd.type = noohubNormalizeText(d.type || "");

    nd.subtype = noohubNormalizeText(d.subtype || "");
    nd.protocol = noohubNormalizeText(d.protocol || "");
    nd.noolite_mode = d.noolite_mode !== undefined ? d.noolite_mode : "";
    nd.noolite_mode_text = noohubNooliteModeText(nd.noolite_mode);
    nd.ch = d.ch !== undefined ? d.ch : "";
    nd.retrievable = d.retrievable !== undefined ? noohubBoolValue(d.retrievable) : false;
    nd.reportable = d.reportable !== undefined ? noohubBoolValue(d.reportable) : false;

    nd.skills = d.skills || [];
    nd.skills_text = noohubSkillsText(nd.skills);
    nd.sensors = d.sensors || [];
    nd.sensors_text = noohubListText(nd.sensors);
    nd.events = d.events || [];
    nd.events_text = noohubListText(nd.events);
    nd.controls = noohubGetControlsForDevice(nd);

    nd.raw_json = noohubRawJson(d);

    return nd;
}

function noohubDeviceMetaChanged(oldDevice, newDevice) {
    if (!oldDevice) {
        return true;
    }

    return (
        String(oldDevice.name || "") !== String(newDevice.name || "") ||
        String(oldDevice.room || "") !== String(newDevice.room || "") ||
        String(oldDevice.model || "") !== String(newDevice.model || "") ||
        String(oldDevice.type || "") !== String(newDevice.type || "") ||
        String(oldDevice.subtype || "") !== String(newDevice.subtype || "") ||
        String(oldDevice.protocol || "") !== String(newDevice.protocol || "") ||
        String(oldDevice.noolite_mode || "") !== String(newDevice.noolite_mode || "") ||
        String(oldDevice.noolite_mode_text || "") !== String(newDevice.noolite_mode_text || "") ||
        String(oldDevice.ch || "") !== String(newDevice.ch || "") ||
        String(!!oldDevice.retrievable) !== String(!!newDevice.retrievable) ||
        String(!!oldDevice.reportable) !== String(!!newDevice.reportable) ||
        String(oldDevice.skills_text || "") !== String(newDevice.skills_text || "") ||
        String(oldDevice.sensors_text || "") !== String(newDevice.sensors_text || "") ||
        String(oldDevice.events_text || "") !== String(newDevice.events_text || "") ||
        String(oldDevice.raw_json || "") !== String(newDevice.raw_json || "")
    );
}

function noohubDeviceControlsChanged(oldDevice, newDevice) {
    if (!oldDevice) {
        return false;
    }

    return noohubControlsKey(oldDevice.controls || []) !== noohubControlsKey(newDevice.controls || []);
}


// -----------------------------------------------------------------------------
// Main settings virtual device
// -----------------------------------------------------------------------------

defineVirtualDevice(NOOHUB_SETTINGS_DEVICE, {
    title: {
        en: "NooHub Bridge Settings"
    },
    cells: {
        noohub_ip: {
            title: {
                en: "NooHub IP"
            },
            type: "text",
            value: noohubIp,
            readonly: false,
            order: 1
        },
        noohub_id: {
            title: {
                en: "NooHub ID"
            },
            type: "text",
            value: noohubId,
            readonly: false,
            order: 2
        },
        api_url: {
            title: {
                en: "API URL"
            },
            type: "text",
            value: noohubApiUrl,
            readonly: true,
            order: 3
        },
        get_devices_type: {
            title: {
                en: "get_devices type"
            },
            type: "text",
            value: noohubGetDevicesType,
            enum: {
                all: {
                    en: "all - все устройства"
                },
                blocks: {
                    en: "blocks - силовые блоки"
                },
                sensors: {
                    en: "sensors - датчики"
                },
                remotes: {
                    en: "remotes - дистанционные выключатели"
                }
            },
            readonly: false,
            order: 4
        },
        devices_count: {
            title: {
                en: "Devices Count"
            },
            type: "value",
            value: 0,
            readonly: true,
            order: 5
        },
        last_scan: {
            title: {
                en: "Last Sync"
            },
            type: "text",
            value: "",
            readonly: true,
            order: 6
        },
        last_poll: {
            title: {
                en: "Last Poll"
            },
            type: "text",
            value: "",
            readonly: true,
            order: 7
        },
        last_save: {
            title: {
                en: "Last Save"
            },
            type: "text",
            value: "",
            readonly: true,
            order: 8
        },
        last_load: {
            title: {
                en: "Last Load"
            },
            type: "text",
            value: "",
            readonly: true,
            order: 9
        },
        auth_enabled: {
            title: {
                en: "Auth Enabled"
            },
            type: "switch",
            value: true,
            readonly: false,
            order: 10
        },
        noohub_username: {
            title: {
                en: "NooHub Username"
            },
            type: "text",
            value: "admin",
            readonly: false,
            order: 11
        },
        noohub_password_input: {
            title: {
                en: "NooHub Password Input"
            },
            type: "text",
            value: "",
            readonly: false,
            order: 12
        },
        save_settings: {
            title: {
                en: "Save Settings"
            },
            type: "pushbutton",
            order: 12.1
        },
        noohub_password_status: {
            title: {
                en: "Password Status"
            },
            type: "text",
            value: "empty",
            readonly: true,
            order: 12.2
        },
        spruthub_mqtt_port: {
            title: {
                en: "SprutHub MQTT Port"
            },
            type: "text",
            value: String(noohubSprutHubMqttPort),
            readonly: false,
            order: 13
        },
        apply_spruthub_mqtt_port: {
            title: {
                en: "Apply SprutHub MQTT Port"
            },
            type: "pushbutton",
            order: 13.1
        },
        resync_ch: {
            title: {
                en: "Resync CH list"
            },
            type: "text",
            value: "",
            readonly: false,
            order: 15
        },
        scan_devices: {
            title: {
                en: "Apply Resync CH list"
            },
            type: "pushbutton",
            order: 16
        },
        delete_ch: {
            title: {
                en: "Delete CH list"
            },
            type: "text",
            value: "",
            readonly: false,
            order: 17
        },
        delete_virtual_devices: {
            title: {
                en: "Apply Delete CH list"
            },
            type: "pushbutton",
            order: 18
        },
        show_device_info_id: {
            title: { en: "Show NooHub ID" },
            type: "switch",
            value: true,
            readonly: false,
            order: 19
        },
        show_device_info_name: {
            title: { en: "Show Name" },
            type: "switch",
            value: true,
            readonly: false,
            order: 20
        },
        show_device_info_room: {
            title: { en: "Show Room" },
            type: "switch",
            value: true,
            readonly: false,
            order: 21
        },
        show_device_info_model: {
            title: { en: "Show Model" },
            type: "switch",
            value: true,
            readonly: false,
            order: 22
        },
        show_device_info_type: {
            title: { en: "Show Type" },
            type: "switch",
            value: true,
            readonly: false,
            order: 23
        },
        show_device_info_subtype: {
            title: { en: "Show Subtype" },
            type: "switch",
            value: true,
            readonly: false,
            order: 24
        },
        show_device_info_protocol: {
            title: { en: "Show Protocol" },
            type: "switch",
            value: true,
            readonly: false,
            order: 25
        },
        show_device_mtrf_ch: {
            title: { en: "Show MTRF CH" },
            type: "switch",
            value: true,
            readonly: false,
            order: 26
        },
        show_device_noolite_mode: {
            title: { en: "Show NooLite Mode" },
            type: "switch",
            value: true,
            readonly: false,
            order: 27
        },
        show_device_retrievable: {
            title: { en: "Show Retrievable" },
            type: "switch",
            value: true,
            readonly: false,
            order: 28
        },
        show_device_reportable: {
            title: { en: "Show Reportable" },
            type: "switch",
            value: true,
            readonly: false,
            order: 29
        },
        show_device_skills: {
            title: { en: "Show Skills" },
            type: "switch",
            value: true,
            readonly: false,
            order: 30
        },
        show_device_sensors: {
            title: { en: "Show Sensors" },
            type: "switch",
            value: true,
            readonly: false,
            order: 31
        },
        show_device_events: {
            title: { en: "Show Events" },
            type: "switch",
            value: true,
            readonly: false,
            order: 32
        },
        show_device_raw_json: {
            title: { en: "Show Raw JSON" },
            type: "switch",
            value: true,
            readonly: false,
            order: 33
        },
        polling_enabled: {
            title: {
                en: "Polling Enabled"
            },
            type: "switch",
            value: false,
            readonly: false,
            order: 40
        },
        poll_now: {
            title: {
                en: "Poll Now"
            },
            type: "pushbutton",
            order: 41
        },
        poll_interval_sec: {
            title: {
                en: "Poll Interval, sec"
            },
            type: "range",
            value: 60,
            min: 1,
            max: 180,
            readonly: false,
            order: 42
        },
        test_connection: {
            title: {
                en: "Test Connection"
            },
            type: "pushbutton",
            order: 43
        },
        reset_runtime_locks: {
            title: {
                en: "Reset Runtime Locks"
            },
            type: "pushbutton",
            order: 44
        },
        status: {
            title: {
                en: "Status"
            },
            type: "text",
            value: "init",
            readonly: true,
            order: 45
        }
    }
});

// -----------------------------------------------------------------------------
// Password encryption / decryption
// -----------------------------------------------------------------------------

function noohubEncryptPassword(password, callback) {
    if (!password) {
        callback("");
        return;
    }

    var cmd =
        "printf %s " + noohubShellQuote(password) +
        " | openssl enc -aes-256-cbc -pbkdf2 -salt -a -A -pass file:/etc/machine-id 2>/dev/null";

    noohubRun(cmd, function(exitCode, output) {
        if (exitCode !== 0 || !output) {
            noohubLog("password encryption failed");
            callback("");
            return;
        }

        callback(String(output).trim());
    });
}

function noohubDecryptPassword(passwordEnc, callback) {
    if (!passwordEnc) {
        callback("");
        return;
    }

    var cmd =
        "printf %s " + noohubShellQuote(passwordEnc) +
        " | openssl enc -d -aes-256-cbc -pbkdf2 -salt -a -A -pass file:/etc/machine-id 2>/dev/null";

    noohubRun(cmd, function(exitCode, output) {
        if (exitCode !== 0) {
            noohubLog("password decrypt failed");
            callback("");
            return;
        }

        callback(String(output || ""));
    });
}


// -----------------------------------------------------------------------------
// Config load / save
// -----------------------------------------------------------------------------

function noohubApplyConfig(cfg) {
    if (!cfg) {
        return;
    }

    noohubSettingsLoading = true;

    if (cfg.noohub_ip !== undefined) {
        noohubIp = String(cfg.noohub_ip);
    }

    if (cfg.noohub_id !== undefined) {
        noohubId = String(cfg.noohub_id);
    }

    if (cfg.get_devices_type !== undefined) {
        noohubGetDevicesType = noohubNormalizeGetDevicesType(cfg.get_devices_type);
    }

    if (cfg.auth_enabled !== undefined) {
        noohubAuthEnabled = !!cfg.auth_enabled;
    }

    if (cfg.noohub_username !== undefined) {
        noohubUsername = String(cfg.noohub_username);
    }

    if (cfg.noohub_password_enc !== undefined) {
        noohubPasswordEnc = String(cfg.noohub_password_enc || "");
    }

    if (cfg.spruthub_mqtt_port !== undefined) {
        noohubSprutHubMqttPort = noohubNormalizeSprutHubMqttPort(cfg.spruthub_mqtt_port);
    }

    if (cfg.spruthub_mqtt_port_applied !== undefined) {
        noohubSprutHubMqttPortApplied = noohubNormalizeSprutHubMqttPort(cfg.spruthub_mqtt_port_applied);
    } else {
        noohubSprutHubMqttPortApplied = noohubSprutHubMqttPort;
    }

    if (cfg.spruthub_ch_filter !== undefined) {
        noohubSprutHubChFilter = String(cfg.spruthub_ch_filter || "");
    }

    if (cfg.polling_enabled !== undefined) {
        dev[NOOHUB_SETTINGS_DEVICE + "/polling_enabled"] = !!cfg.polling_enabled;
    }

    if (cfg.poll_interval_sec !== undefined) {
        dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"] = noohubNormalizePollInterval(cfg.poll_interval_sec);
    }

    noohubApplyDeviceInfoVisibilityConfig(cfg.device_info_visible);

    noohubApiUrl = "http://" + noohubIp + "/api";

    dev[NOOHUB_SETTINGS_DEVICE + "/noohub_ip"] = noohubIp;
    dev[NOOHUB_SETTINGS_DEVICE + "/noohub_id"] = noohubId;
    dev[NOOHUB_SETTINGS_DEVICE + "/api_url"] = noohubApiUrl;
    dev[NOOHUB_SETTINGS_DEVICE + "/get_devices_type"] = noohubGetDevicesType;
    dev[NOOHUB_SETTINGS_DEVICE + "/auth_enabled"] = noohubAuthEnabled;
    dev[NOOHUB_SETTINGS_DEVICE + "/noohub_username"] = noohubUsername;
    dev[NOOHUB_SETTINGS_DEVICE + "/noohub_password_input"] = "";
    dev[NOOHUB_SETTINGS_DEVICE + "/spruthub_mqtt_port"] = String(noohubSprutHubMqttPort);
    dev[NOOHUB_SETTINGS_DEVICE + "/resync_ch"] = noohubSprutHubChFilter;
    if (cfg.polling_enabled === undefined) {
        dev[NOOHUB_SETTINGS_DEVICE + "/polling_enabled"] = false;
    }
    if (cfg.poll_interval_sec === undefined) {
        dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"] = noohubNormalizePollInterval(dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"] || 60);
    }
    noohubSyncDeviceInfoVisibilityControls();

    noohubSetPasswordStatus();
    noohubSettingsLoading = false;
}

function noohubLoadSettings(callback) {
    noohubReadFile(NOOHUB_CONFIG_FILE, function(raw) {
        if (!raw || String(raw).trim() === "") {
            noohubLog("config file not found or empty");
            noohubSyncDeviceInfoVisibilityControls();
            noohubSetPasswordStatus();
            dev[NOOHUB_SETTINGS_DEVICE + "/last_load"] = noohubNowString();

            if (callback) {
                callback(false);
            }

            return;
        }

        var cfg = noohubSafeJsonParse(raw, "config load");

        if (!cfg) {
            noohubSetStatus("config JSON parse error");

            if (callback) {
                callback(false);
            }

            return;
        }

        noohubApplyConfig(cfg);

        if (noohubPasswordEnc) {
            noohubDecryptPassword(noohubPasswordEnc, function(pass) {
                noohubPasswordPlain = pass || "";
                noohubSetPasswordStatus();
                dev[NOOHUB_SETTINGS_DEVICE + "/last_load"] = noohubNowString();
                noohubSetStatus("config loaded");

                if (callback) {
                    callback(true);
                }
            });
        } else {
            noohubPasswordPlain = "";
            noohubSetPasswordStatus();
            dev[NOOHUB_SETTINGS_DEVICE + "/last_load"] = noohubNowString();
            noohubSetStatus("config loaded, password empty");

            if (callback) {
                callback(true);
            }
        }
    });
}

function noohubSaveSettings(silent) {
    noohubUpdateApiUrlFromIp();

    noohubId = String(dev[NOOHUB_SETTINGS_DEVICE + "/noohub_id"] || noohubId);
    noohubUpdateGetDevicesTypeFromControl();
    noohubAuthEnabled = !!dev[NOOHUB_SETTINGS_DEVICE + "/auth_enabled"];
    noohubUsername = String(dev[NOOHUB_SETTINGS_DEVICE + "/noohub_username"] || "admin");
    noohubSprutHubMqttPort = noohubNormalizeSprutHubMqttPort(dev[NOOHUB_SETTINGS_DEVICE + "/spruthub_mqtt_port"]);
    dev[NOOHUB_SETTINGS_DEVICE + "/spruthub_mqtt_port"] = String(noohubSprutHubMqttPort);
    noohubUpdateDeviceInfoVisibilityFromControls();

    var inputPass = String(dev[NOOHUB_SETTINGS_DEVICE + "/noohub_password_input"] || "");

    function writeConfig() {
        var cfg = {
            noohub_ip: noohubIp,
            noohub_id: noohubId,
            api_url: noohubApiUrl,
            get_devices_type: noohubGetDevicesType,
            auth_enabled: noohubAuthEnabled,
            noohub_username: noohubUsername,
            noohub_password_enc: noohubPasswordEnc,
            spruthub_mqtt_port: noohubSprutHubMqttPort,
            spruthub_mqtt_port_applied: noohubSprutHubMqttPortApplied,
            spruthub_ch_filter: noohubSprutHubChFilter,
            polling_enabled: !!dev[NOOHUB_SETTINGS_DEVICE + "/polling_enabled"],
            poll_interval_sec: noohubNormalizePollInterval(dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"]),
            device_info_visible: noohubDeviceInfoVisibilityConfig()
        };

        noohubWriteFile(NOOHUB_CONFIG_FILE, JSON.stringify(cfg, null, 2), function(ok) {
            dev[NOOHUB_SETTINGS_DEVICE + "/noohub_password_input"] = "";
            noohubSetPasswordStatus();
            dev[NOOHUB_SETTINGS_DEVICE + "/last_save"] = noohubNowString();

            if (ok && !silent) {
                noohubSetStatus("settings saved");
            } else if (!ok) {
                noohubSetStatus("settings save failed");
            }
        });
    }

    if (inputPass !== "") {
        noohubPasswordPlain = inputPass;

        noohubEncryptPassword(inputPass, function(enc) {
            if (!enc) {
                noohubSetStatus("password encryption failed");
                return;
            }

            noohubPasswordEnc = enc;
            writeConfig();
        });
    } else {
        writeConfig();
    }
}


// -----------------------------------------------------------------------------
// SprutHub MQTT broker
// -----------------------------------------------------------------------------

function noohubBuildSprutHubMqttConfig(port) {
    return [
        "# Dedicated NooHub-only MQTT broker for SprutHub.",
        "# This file is generated by /etc/wb-rules/noohub_bridge.js.",
        "# SprutHub MQTT controller can connect to the Wiren Board IP:",
        "# <wirenboard-ip>:" + port + ".",
        "",
        "listener " + port + " 0.0.0.0",
        "allow_anonymous true",
        "persistence false",
        "log_dest syslog",
        ""
    ].join("\n");
}

function noohubBuildSprutHubMqttProxyEnv(port, allowedIds, blockAll) {
    return [
        "NOOHUB_SPRUTHUB_MQTT_HOST=127.0.0.1",
        "NOOHUB_SPRUTHUB_MQTT_PORT=" + port,
        "NOOHUB_SPRUTHUB_ALLOWED_IDS=" + noohubShellQuote((allowedIds || []).join(" ")),
        "NOOHUB_SPRUTHUB_BLOCK_ALL=" + (blockAll ? "1" : "0"),
        "NOOHUB_SPRUTHUB_MIRROR_LEGACY_PREFIX=0",
        "WB_MQTT_HOST=127.0.0.1",
        "WB_MQTT_PORT=1883",
        ""
    ].join("\n");
}

function noohubAllowedSprutHubIdsFromList(list) {
    var out = [];
    var seen = {};

    if (!list) {
        list = [];
    }

    for (var i = 0; i < list.length; i++) {
        var nd = noohubNormalizeDevice(list[i]);

        if (!nd.id || !noohubIsDeviceAllowedForSprutHub(nd)) {
            continue;
        }

        if (!seen[nd.id]) {
            seen[nd.id] = true;
            out.push(nd.id);
        }
    }

    out.sort();
    return out;
}

function noohubFindDevicesByChannelsInNooHubList(channels, list) {
    var out = [];
    var seenCh = {};
    var wanted = {};

    channels = noohubParseResyncChList((channels || []).join(","));
    list = list || [];

    for (var i = 0; i < channels.length; i++) {
        var ch = noohubNormalizeChForCompare(channels[i]);

        if (ch) {
            wanted[ch] = true;
        }
    }

    for (var j = 0; j < list.length; j++) {
        var nd = noohubNormalizeDevice(list[j]);
        var ndCh = noohubNormalizeChForCompare(nd.ch);

        if (!nd.id || !wanted[ndCh] || seenCh[ndCh]) {
            continue;
        }

        seenCh[ndCh] = true;
        out.push(nd);
    }

    return out;
}

function noohubUniqueStringList(list) {
    var out = [];
    var seen = {};

    list = list || [];

    for (var i = 0; i < list.length; i++) {
        var value = String(list[i] || "");

        if (!value || seen[value]) {
            continue;
        }

        seen[value] = true;
        out.push(value);
    }

    out.sort();
    return out;
}

function noohubDeviceIdsFromList(list) {
    var out = [];
    var seen = {};

    list = list || [];

    for (var i = 0; i < list.length; i++) {
        var nd = noohubNormalizeDevice(list[i]);

        if (!nd.id || seen[nd.id]) {
            continue;
        }

        seen[nd.id] = true;
        out.push(nd.id);
    }

    out.sort();
    return out;
}

function noohubSprutHubProxyStateFromDeviceList(list, blockWhenNoAllowed) {
    var filter = noohubSprutHubChFilterList();
    var devices = list || [];
    var allowedDevices = [];

    if (filter.length > 0) {
        allowedDevices = noohubFindDevicesByChannelsInNooHubList(filter, devices);
    } else {
        allowedDevices = devices;
    }

    var allowedIds = noohubDeviceIdsFromList(allowedDevices);

    return {
        allowedIds: allowedIds,
        blockAll: !!blockWhenNoAllowed && allowedIds.length === 0
    };
}

function noohubApplySprutHubProxyAllowedIds(allowedIds, blockAll, callback) {
    allowedIds = noohubUniqueStringList(allowedIds || []);

    var env = noohubBuildSprutHubMqttProxyEnv(
        noohubSprutHubMqttPortApplied || noohubSprutHubMqttPort,
        blockAll ? [] : allowedIds,
        blockAll
    );

    noohubWriteFile(NOOHUB_SPRUTHUB_MQTT_PROXY_ENV, env, function(ok) {
        if (!ok) {
            noohubSetStatus("SprutHub proxy allow-list write failed");

            if (callback) {
                callback(false);
            }

            return;
        }

        noohubRun("systemctl restart noohub_spruthub_mqtt_proxy", function(exitCode, output) {
            if (exitCode !== 0) {
                noohubSetStatus("SprutHub proxy restart failed");

                if (output) {
                    noohubLog("SprutHub proxy restart output: " + output.substr(0, 300));
                }

                if (callback) {
                    callback(false);
                }

                return;
            }

            noohubLog(
                "SprutHub proxy allow-list applied: " +
                (blockAll ? "BLOCK_ALL" : (allowedIds.join(",") || "ALL"))
            );

            if (callback) {
                callback(true);
            }
        });
    });
}

function noohubApplySprutHubProxyAllowList(list, blockAll, callback) {
    var allowedIds = blockAll ? [] : noohubAllowedSprutHubIdsFromList(list || noohubDevices);
    noohubApplySprutHubProxyAllowedIds(allowedIds, blockAll, callback);
}

function noohubBuildPortBusyCheckCommand(port) {
    var p = parseInt(port, 10);

    return "if command -v ss >/dev/null 2>&1; then " +
        "ss -ltn; " +
        "elif command -v netstat >/dev/null 2>&1; then " +
        "netstat -ltn; " +
        "else exit 0; fi | " +
        "awk '{print $4}' | grep -Eq '(^|[.:])" + p + "$'";
}

function noohubApplySprutHubMqttPort() {
    var previousPort = noohubSprutHubMqttPortApplied;

    noohubSprutHubMqttPort = noohubNormalizeSprutHubMqttPort(
        dev[NOOHUB_SETTINGS_DEVICE + "/spruthub_mqtt_port"]
    );

    dev[NOOHUB_SETTINGS_DEVICE + "/spruthub_mqtt_port"] = String(noohubSprutHubMqttPort);

    noohubSetStatus("applying SprutHub MQTT port: " + noohubSprutHubMqttPort);

    function writeConfigAndRestart() {
        var proxyState = noohubSprutHubProxyStateFromDeviceList(noohubDevices, true);
        var brokerConf = noohubBuildSprutHubMqttConfig(noohubSprutHubMqttPort);
        var proxyEnv = noohubBuildSprutHubMqttProxyEnv(
            noohubSprutHubMqttPort,
            proxyState.allowedIds,
            proxyState.blockAll
        );

        noohubWriteFile(NOOHUB_SPRUTHUB_MQTT_CONF, brokerConf, function(confOk) {
            if (!confOk) {
                noohubSetStatus("SprutHub MQTT port apply failed: broker config write error");
                return;
            }

            noohubWriteFile(NOOHUB_SPRUTHUB_MQTT_PROXY_ENV, proxyEnv, function(envOk) {
                if (!envOk) {
                    noohubSetStatus("SprutHub MQTT port apply failed: proxy env write error");
                    return;
                }

                var cmd =
                    "if [ -f " + noohubShellQuote(NOOHUB_SPRUTHUB_LEGACY_LISTENER_CONF) + " ]; then " +
                    "rm -f " + noohubShellQuote(NOOHUB_SPRUTHUB_LEGACY_LISTENER_CONF) + " && systemctl restart mosquitto; fi" +
                    " && systemctl restart noohub_spruthub_mosquitto" +
                    " && systemctl restart noohub_spruthub_mqtt_proxy";

                noohubRun(cmd, function(exitCode, output) {
                    if (exitCode === 0) {
                        noohubSprutHubMqttPortApplied = noohubSprutHubMqttPort;
                        noohubSaveSettings(true);
                        noohubSetStatus(
                            "SprutHub MQTT port applied: Wiren Board IP:" +
                            noohubSprutHubMqttPort +
                            ". Previous port " + previousPort + " stopped after broker restart."
                        );
                    } else {
                        noohubSetStatus("SprutHub MQTT port apply failed: service restart error");
                        if (output) {
                            noohubLog("SprutHub MQTT port apply output: " + output.substr(0, 300));
                        }
                    }
                });
            });
        });
    }

    if (noohubSprutHubMqttPort !== previousPort) {
        noohubRun(noohubBuildPortBusyCheckCommand(noohubSprutHubMqttPort), function(exitCode, output) {
            if (exitCode === 0) {
                noohubSetStatus("SprutHub MQTT port is busy: " + noohubSprutHubMqttPort);
                if (output) {
                    noohubLog("busy port check output: " + output.substr(0, 300));
                }
                return;
            }

            writeConfigAndRestart();
        });
        return;
    }

    writeConfigAndRestart();
}


// -----------------------------------------------------------------------------
// NooHub HTTP API
// -----------------------------------------------------------------------------

function noohubBuildCurlCommand(requestJson, captureResponse) {
    var authPart = "";
    var connectTimeout = captureResponse ? NOOHUB_CURL_CONNECT_TIMEOUT_SEC : NOOHUB_COMMAND_CURL_CONNECT_TIMEOUT_SEC;
    var maxTime = captureResponse ? NOOHUB_CURL_MAX_TIME_SEC : NOOHUB_COMMAND_CURL_MAX_TIME_SEC;

    if (noohubAuthEnabled) {
        authPart =
            " --http1.0 --digest -u " +
            noohubShellQuote(noohubUsername + ":" + noohubPasswordPlain);
    }

    var curlCmd =
        "curl -sS --connect-timeout " + connectTimeout +
        " --max-time " + maxTime + authPart +
        " -H 'Content-Type: application/json'" +
        " " + noohubShellQuote(noohubApiUrl) +
        " --data-binary @-";

    var feedReq = "printf %s " + noohubShellQuote(requestJson) + " | ";

    if (captureResponse) {
        return feedReq + curlCmd;
    }

    return feedReq + curlCmd + " -o /dev/null >/dev/null 2>&1 &";
}

function noohubApiRequest(obj, callback, quiet) {
    noohubUpdateApiUrlFromIp();

    var requestJson = JSON.stringify(obj);
    var cmd = noohubBuildCurlCommand(requestJson, true);

    noohubRun(cmd, function(exitCode, output) {
        if (exitCode !== 0) {
            if (!quiet) {
                noohubSetStatus("curl failed, exit " + exitCode + ": " + noohubShortRawForStatus(output));
            }
            noohubLog("curl output: " + output.substr(0, 500));

            if (callback) {
                callback(null, output);
            }

            return;
        }

        var parsed = noohubSafeJsonParse(output, "api response");

        if (callback) {
            callback(parsed, output);
        }
    }, quiet);
}

function noohubApiGetAllDevicesWithFallback(callback, quiet) {
    noohubApiRequest(noohubBuildGetAllDevicesRequest(), function(resp, raw) {
        if (noohubIsGoodDevicesResponse(resp)) {
            callback(resp, raw, false);
            return;
        }

        noohubUpdateGetDevicesTypeFromControl();

        if (noohubGetDevicesType === "all") {
            callback(null, raw, false);
            return;
        }

        noohubLog("get_devices all failed, fallback to " + noohubGetDevicesType + ": " + noohubShortRawForStatus(raw));

        noohubApiRequest(noohubBuildGetDevicesRequest(), function(fallbackResp, fallbackRaw) {
            if (noohubIsGoodDevicesResponse(fallbackResp)) {
                callback(fallbackResp, fallbackRaw, true);
                return;
            }

            callback(null, fallbackRaw || raw, true);
        }, quiet);
    }, quiet);
}

function noohubApiFireAndForget(obj) {
    noohubUpdateApiUrlFromIp();

    var requestJson = JSON.stringify(obj);
    var cmd = noohubBuildCurlCommand(requestJson, false);

    noohubRun(cmd, function(exitCode, output) {
        // fire-and-forget
    }, true);
}

function noohubTestConnection() {
    noohubSetStatus("testing connection");

    noohubApiRequest(noohubBuildGetDevicesRequest(), function(resp, raw) {
        if (noohubIsGoodDevicesResponse(resp)) {
            noohubSetStatus("test ok: devices=" + ((resp.devices || []).length));
            return;
        }

        noohubLog("test current get_devices failed: " + noohubShortRawForStatus(raw));

        noohubApiRequest(noohubBuildGetAllDevicesRequest(), function(respAll, rawAll) {
            if (noohubIsGoodDevicesResponse(respAll)) {
                noohubSetStatus("test ok with all devices: devices=" + ((respAll.devices || []).length) + ". Check get_devices type " + noohubGetDevicesType);
                return;
            }

            noohubSetStatus("test failed: " + noohubDevicesResponseErrorText(rawAll || raw));
        }, true);
    });
}


// -----------------------------------------------------------------------------
// Device save / load
// -----------------------------------------------------------------------------

function noohubSaveDevicesToFile(callback) {
    var obj = {
        saved_at: noohubNowString(),
        devices: noohubDevices
    };

    noohubWriteFile(NOOHUB_DEVICES_FILE, JSON.stringify(obj, null, 2), function(ok) {
        if (ok) {
            noohubLog("devices saved: " + noohubDevices.length);
        } else {
            noohubLog("devices save failed");
        }

        if (callback) {
            callback(ok);
        }
    });
}

function noohubLoadDevicesFromFile(callback) {
    noohubReadFile(NOOHUB_DEVICES_FILE, function(raw) {
        if (!raw || String(raw).trim() === "") {
            noohubLog("devices file not found or empty");

            var emptyProxyState = noohubSprutHubProxyStateFromDeviceList([], true);
            noohubPruneSprutHubBrokerToAllowedIds(emptyProxyState.allowedIds);
            noohubApplySprutHubProxyAllowedIds(emptyProxyState.allowedIds, emptyProxyState.blockAll);

            if (callback) {
                callback(false);
            }

            return;
        }

        var parsed = noohubSafeJsonParse(raw, "devices load");

        if (!parsed) {
            noohubSetStatus("devices JSON parse error");

            if (callback) {
                callback(false);
            }

            return;
        }

        var list = [];

        if (parsed.devices && Array.isArray(parsed.devices)) {
            list = parsed.devices;
        } else if (Array.isArray(parsed)) {
            list = parsed;
        }

        noohubDevices = [];
        noohubDeviceById = {};

        for (var i = 0; i < list.length; i++) {
            var nd = noohubNormalizeDevice(list[i]);

            if (!nd.id) {
                continue;
            }

            noohubDevices.push(nd);
            noohubDeviceById[nd.id] = nd;
            noohubCreateVirtualDevice(nd);
        }

        dev[NOOHUB_SETTINGS_DEVICE + "/devices_count"] = noohubDevices.length;
        noohubUpdateAllSprutHubMarkers();
        var proxyState = noohubSprutHubProxyStateFromDeviceList(noohubDevices, true);
        noohubPruneSprutHubBrokerToAllowedIds(proxyState.allowedIds);
        noohubApplySprutHubProxyAllowedIds(proxyState.allowedIds, proxyState.blockAll);
        noohubSetStatus("devices loaded from file: " + noohubDevices.length);

        if (callback) {
            callback(true);
        }
    });
}

function noohubGetSavedDeviceById(id) {
    if (!id) {
        return null;
    }

    if (noohubDeviceById && noohubDeviceById[id]) {
        return noohubDeviceById[id];
    }

    for (var i = 0; i < noohubDevices.length; i++) {
        if (noohubDevices[i] && noohubDevices[i].id === id) {
            return noohubDevices[i];
        }
    }

    return null;
}

function noohubIsLocalStateDevice(d) {
    return !!(d && d.id && d.retrievable !== true);
}

function noohubShouldStartupResetDevice(d) {
    if (!noohubIsLocalStateDevice(d)) {
        return false;
    }

    var controls = d.controls || noohubGetControlsForDevice(d);

    if (controls.indexOf("on_button") >= 0 || controls.indexOf("pulse") >= 0) {
        return false;
    }

    return controls.indexOf("on") >= 0;
}

function noohubApplyLocalStateFromCommand(id, state, statusText) {
    var d = noohubGetSavedDeviceById(id);

    if (!noohubIsLocalStateDevice(d)) {
        return false;
    }

    var vd = "noohub_" + id;
    var controls = d.controls || noohubGetControlsForDevice(d);

    noohubSetUpdatingFromPoll(true);

    try {
        if (state && state.on !== undefined && controls.indexOf("on") >= 0 && dev[vd + "/on"] !== undefined) {
            noohubSetDevIfChanged(vd + "/on", noohubMqttValueToOn(state.on) === 1);
        }

        if (state && state.brightness !== undefined && controls.indexOf("brightness") >= 0 && dev[vd + "/brightness"] !== undefined) {
            var b = parseInt(state.brightness, 10);

            if (isNaN(b)) {
                b = 0;
            }

            if (b < 0) {
                b = 0;
            }

            if (b > 100) {
                b = 100;
            }

            noohubSetDevIfChanged(vd + "/brightness", b);
        } else if (state && noohubMqttValueToOn(state.on) === 0 &&
            controls.indexOf("brightness") >= 0 && dev[vd + "/brightness"] !== undefined) {
            noohubSetDevIfChanged(vd + "/brightness", 0);
        }

        if (dev[vd + "/last_update"] !== undefined) {
            dev[vd + "/last_update"] = noohubNowString();
        }

        if (dev[vd + "/status"] !== undefined) {
            noohubSetDevIfChanged(vd + "/status", statusText || "local state");
        }
    } catch (e) {
        noohubLog("local state update failed for " + id + ": " + e);
    } finally {
        noohubSetUpdatingFromPoll(false);
    }

    return true;
}

function noohubResetNonRetrievableDevicesOnStartup() {
    var resetList = [];

    for (var i = 0; i < noohubDevices.length; i++) {
        if (noohubShouldStartupResetDevice(noohubDevices[i])) {
            resetList.push(noohubDevices[i]);
        }
    }

    if (resetList.length === 0) {
        noohubLog("startup off reset: no non-retrievable switch devices");
        return;
    }

    noohubSetStatus("startup off reset scheduled: " + resetList.length);

    for (var n = 0; n < resetList.length; n++) {
        (function(d, index) {
            setTimeout(function() {
                noohubLog("startup off reset for no-feedback device: " + d.id);
                noohubApplyLocalStateFromCommand(d.id, { on: 0 }, "startup off");
                noohubSendSetState(d.id, { on: 0 });
            }, NOOHUB_STARTUP_RESET_DELAY_MS + index * NOOHUB_STARTUP_RESET_STEP_MS);
        })(resetList[n], n);
    }
}


// -----------------------------------------------------------------------------
// Device card helpers
// -----------------------------------------------------------------------------

function noohubPadChannel(ch) {
    if (ch === undefined || ch === null || ch === "") {
        return "---";
    }

    var n = parseInt(ch, 10);

    if (isNaN(n)) {
        return String(ch);
    }

    if (n < 10) {
        return "00" + n;
    }

    if (n < 100) {
        return "0" + n;
    }

    return String(n);
}

function noohubMakeDeviceTitle(d) {
    var title = d.name || d.id;

    if (d.room) {
        title = d.room + " / " + title;
    }

    if (d.model) {
        title = title + " [" + d.model + "]";
    }

    title = "CH " + noohubPadChannel(d.ch) + " — " + title;

    return title;
}

function noohubAddInfoTextCell(cells, name, title, value, order) {
    cells[name] = {
        title: {
            en: title
        },
        type: "text",
        value: value !== undefined && value !== null ? String(value) : "",
        readonly: true,
        order: order
    };
}

function noohubAddInfoSwitchCell(cells, name, title, value, order) {
    cells[name] = {
        title: {
            en: title
        },
        type: "switch",
        value: !!value,
        readonly: true,
        order: order
    };
}

function noohubAddDeviceInfoCells(cells, d) {
    if (noohubIsDeviceInfoVisible("info_id")) {
        noohubAddInfoTextCell(cells, "info_id", "NooHub ID", d.id, 70);
    }

    if (noohubIsDeviceInfoVisible("info_name")) {
        noohubAddInfoTextCell(cells, "info_name", "Name", d.name, 71);
    }

    if (noohubIsDeviceInfoVisible("info_room")) {
        noohubAddInfoTextCell(cells, "info_room", "Room", d.room, 72);
    }

    if (noohubIsDeviceInfoVisible("info_model")) {
        noohubAddInfoTextCell(cells, "info_model", "Model", d.model, 73);
    }

    if (noohubIsDeviceInfoVisible("info_type")) {
        noohubAddInfoTextCell(cells, "info_type", "Type", d.type, 74);
    }

    if (noohubIsDeviceInfoVisible("info_subtype")) {
        noohubAddInfoTextCell(cells, "info_subtype", "Subtype", d.subtype, 75);
    }

    if (noohubIsDeviceInfoVisible("info_protocol")) {
        noohubAddInfoTextCell(cells, "info_protocol", "Protocol", d.protocol, 76);
    }

    if (noohubIsDeviceInfoVisible("mtrf_ch")) {
        noohubAddInfoTextCell(cells, "mtrf_ch", "MTRF Ch", d.ch, 77);
    }

    if (noohubIsDeviceInfoVisible("noolite_mode")) {
        noohubAddInfoTextCell(cells, "noolite_mode", "NooLite Mode", d.noolite_mode_text, 78);
    }

    if (noohubIsDeviceInfoVisible("retrievable")) {
        noohubAddInfoSwitchCell(cells, "retrievable", "Retrievable", d.retrievable, 79);
    }

    if (noohubIsDeviceInfoVisible("reportable")) {
        noohubAddInfoSwitchCell(cells, "reportable", "Reportable", d.reportable, 80);
    }

    if (noohubIsDeviceInfoVisible("skills")) {
        noohubAddInfoTextCell(cells, "skills", "Skills", d.skills_text, 81);
    }

    if (noohubIsDeviceInfoVisible("sensors")) {
        noohubAddInfoTextCell(cells, "sensors", "Sensors", d.sensors_text, 82);
    }

    if (noohubIsDeviceInfoVisible("events")) {
        noohubAddInfoTextCell(cells, "events", "Events", d.events_text, 83);
    }

    if (noohubIsDeviceInfoVisible("raw_json")) {
        noohubAddInfoTextCell(cells, "raw_json", "Raw JSON", d.raw_json, 84);
    }
}


function noohubClampPercent(v) {
    var n = parseInt(v, 10);

    if (isNaN(n)) {
        n = 0;
    }

    if (n < 0) {
        n = 0;
    }

    if (n > 100) {
        n = 100;
    }

    return n;
}

function noohubDefinePushStateRule(id, vd, controlName, stateKey, stateValue) {
    defineRule("noohub_rule_" + id + "_" + controlName, {
        whenChanged: vd + "/" + controlName,
        then: function(newValue, devName, cellName) {
            if (noohubIsUpdatingFromPoll()) {
                return;
            }

            if (noohubMqttValueToOn(newValue) !== 1) {
                return;
            }

            var realId = devName.replace(/^noohub_/, "");
            var st = {};
            st[stateKey] = stateValue;
            noohubSendSetState(realId, st);
        }
    });
}

function noohubDefineValueStateRule(id, vd, controlName, stateKey, mode) {
    defineRule("noohub_rule_" + id + "_" + controlName, {
        whenChanged: vd + "/" + controlName,
        then: function(newValue, devName, cellName) {
            if (noohubIsUpdatingFromPoll()) {
                return;
            }

            var realId = devName.replace(/^noohub_/, "");
            var value = newValue;

            if (mode === "percent") {
                value = noohubClampPercent(newValue);
            } else if (mode === "switch") {
                value = noohubMqttValueToOn(newValue);

                if (value === null) {
                    noohubLog("unknown " + controlName + " command value: " + newValue);
                    return;
                }
            } else {
                value = String(newValue || "");

                if (value === "") {
                    return;
                }
            }

            var st = {};
            st[stateKey] = value;
            noohubSendSetState(realId, st);
        }
    });
}

function noohubDefineSimpleControlRules(id, vd, controls) {
    if (controls.indexOf("switch") >= 0) {
        noohubDefinePushStateRule(id, vd, "switch", "switch", 1);
    }

    if (controls.indexOf("percent_open") >= 0) {
        noohubDefineValueStateRule(id, vd, "percent_open", "percent_open", "percent");
    }

    if (controls.indexOf("open_close") >= 0) {
        noohubDefineValueStateRule(id, vd, "open_close", "open_close", "switch");
    }

    if (controls.indexOf("pause") >= 0) {
        noohubDefinePushStateRule(id, vd, "pause", "pause", 1);
    }

    if (controls.indexOf("open") >= 0) {
        noohubDefinePushStateRule(id, vd, "open", "open", 1);
    }

    if (controls.indexOf("close") >= 0) {
        noohubDefinePushStateRule(id, vd, "close", "close", 1);
    }

    if (controls.indexOf("speed_mode_switch") >= 0) {
        noohubDefinePushStateRule(id, vd, "speed_mode_switch", "speed_mode_switch", 1);
    }

    if (controls.indexOf("switch_color") >= 0) {
        noohubDefinePushStateRule(id, vd, "switch_color", "switch_color", 1);
    }

    if (controls.indexOf("overflow_color") >= 0) {
        noohubDefinePushStateRule(id, vd, "overflow_color", "overflow_color", 1);
    }

    if (controls.indexOf("thermostat") >= 0) {
        noohubDefineValueStateRule(id, vd, "thermostat", "thermostat", "text");
    }

    if (controls.indexOf("color") >= 0) {
        noohubDefineValueStateRule(id, vd, "color", "color", "text");
    }
}


// -----------------------------------------------------------------------------
// Virtual NooHub devices
// -----------------------------------------------------------------------------

function noohubCreateVirtualDevice(d) {
    if (!d || !d.id) {
        return;
    }

    var vd = "noohub_" + d.id;

    if (noohubCreatedDevices[vd]) {
        return;
    }

    var cells = {};
    var controls = d.controls || noohubGetControlsForDevice(d);

    if (controls.indexOf("on") >= 0) {
        cells.on = {
            title: {
                en: "On"
            },
            type: "switch",
            value: false,
            readonly: false,
            order: 1
        };
    }

    if (controls.indexOf("on_button") >= 0) {
        cells.on = {
            title: {
                en: "On / Impulse"
            },
            type: "pushbutton",
            order: 1
        };
    }

    if (controls.indexOf("brightness") >= 0) {
        cells.brightness = {
            title: {
                en: "Brightness"
            },
            type: "range",
            value: 0,
            min: 0,
            max: 100,
            readonly: false,
            order: 2
        };
    }

    if (controls.indexOf("pulse") >= 0) {
        cells.pulse = {
            title: {
                en: "Pulse"
            },
            type: "pushbutton",
            order: 3
        };
    }

    if (controls.indexOf("switch") >= 0) {
        cells.switch = { title: { en: "Switch / Toggle" }, type: "pushbutton", order: 4 };
    }

    if (controls.indexOf("percent_open") >= 0) {
        cells.percent_open = { title: { en: "Percent Open" }, type: "range", value: 0, min: 0, max: 100, readonly: false, order: 5 };
    }

    if (controls.indexOf("open_close") >= 0) {
        cells.open_close = { title: { en: "Open / Close" }, type: "switch", value: false, readonly: false, order: 6 };
    }

    if (controls.indexOf("pause") >= 0) {
        cells.pause = { title: { en: "Pause" }, type: "pushbutton", order: 7 };
    }

    if (controls.indexOf("open") >= 0) {
        cells.open = { title: { en: "Open" }, type: "pushbutton", order: 7.1 };
    }

    if (controls.indexOf("close") >= 0) {
        cells.close = { title: { en: "Close" }, type: "pushbutton", order: 7.2 };
    }

    if (controls.indexOf("speed_mode_switch") >= 0) {
        cells.speed_mode_switch = { title: { en: "Speed Mode Switch" }, type: "pushbutton", order: 8 };
    }

    if (controls.indexOf("switch_color") >= 0) {
        cells.switch_color = { title: { en: "Switch Color" }, type: "pushbutton", order: 9 };
    }

    if (controls.indexOf("overflow_color") >= 0) {
        cells.overflow_color = { title: { en: "Overflow Color" }, type: "pushbutton", order: 10 };
    }

    if (controls.indexOf("thermostat") >= 0) {
        cells.thermostat = { title: { en: "Thermostat" }, type: "text", value: "", readonly: false, order: 11 };
    }

    if (controls.indexOf("color") >= 0) {
        cells.color = { title: { en: "Color" }, type: "text", value: "", readonly: false, order: 12 };
    }

    noohubAddDeviceInfoCells(cells, d);

    cells.last_update = {
        title: {
            en: "Last Update"
        },
        type: "text",
        value: "",
        readonly: true,
        order: 90
    };

    cells.status = {
        title: {
            en: "Status"
        },
        type: "text",
        value: "",
        readonly: true,
        order: 91
    };

    defineVirtualDevice(vd, {
        title: {
            en: noohubMakeDeviceTitle(d)
        },
        cells: cells
    });

    noohubCreatedDevices[vd] = true;

    if (controls.indexOf("on") >= 0 || controls.indexOf("on_button") >= 0) {
        defineRule("noohub_rule_" + d.id + "_on", {
            whenChanged: vd + "/on",
            then: function(newValue, devName, cellName) {
                if (noohubIsUpdatingFromPoll()) {
                    return;
                }

                var id = devName.replace(/^noohub_/, "");

                if (controls.indexOf("on_button") >= 0) {
                    if (noohubMqttValueToOn(newValue) !== 1) {
                        return;
                    }

                    noohubSendSetState(id, {
                        on: 1
                    });
                    return;
                }

                var onValue = noohubMqttValueToOn(newValue);

                if (onValue === null) {
                    noohubLog("unknown on command value: " + newValue);
                    return;
                }

                noohubSendSetState(id, {
                    on: onValue
                });
            }
        });
    }

    if (controls.indexOf("brightness") >= 0) {
        defineRule("noohub_rule_" + d.id + "_brightness", {
            whenChanged: vd + "/brightness",
            then: function(newValue, devName, cellName) {
                if (noohubIsUpdatingFromPoll()) {
                    return;
                }

                var id = devName.replace(/^noohub_/, "");
                var b = parseInt(newValue, 10);

                if (isNaN(b)) {
                    b = 0;
                }

                if (b < 0) {
                    b = 0;
                }

                if (b > 100) {
                    b = 100;
                }

                if (b <= 0) {
                    noohubSendSetState(id, {
                        on: 0
                    });
                } else {
                    noohubSendSetState(id, {
                        on: 1,
                        brightness: b
                    });
                }
            }
        });
    }

    if (controls.indexOf("pulse") >= 0) {
        defineRule("noohub_rule_" + d.id + "_pulse", {
            whenChanged: vd + "/pulse",
            then: function(newValue, devName, cellName) {
                if (noohubIsUpdatingFromPoll()) {
                    return;
                }

                if (noohubMqttValueToOn(newValue) !== 1) {
                    return;
                }

                var id = devName.replace(/^noohub_/, "");

                noohubSendSetState(id, {
                    on: 1
                });
            }
        });
    }

    noohubDefineSimpleControlRules(d.id, vd, controls);

    noohubLog("virtual device created: " + vd);
}

function noohubSendSetState(id, state) {
    if (!id) {
        return;
    }

    var vd = "noohub_" + id;

    if (dev[vd + "/status"] !== undefined) {
        dev[vd + "/status"] = "send";
    }

    noohubMarkCommandActivity();

    if (noohubPollingBusy) {
        if (dev[vd + "/status"] !== undefined) {
            dev[vd + "/status"] = "wait poll";
        }

        setTimeout(function() {
            noohubSendSetStateAttempt(id, state, 1);
        }, NOOHUB_SET_STATE_POLLING_DELAY_MS);

        return;
    }

    noohubSendSetStateAttempt(id, state, 1);
}

function noohubSendSetStateAttempt(id, state, attempt) {
    var vd = "noohub_" + id;

    var req = {
        action: "set_state",
        devices: [
            {
                id: id,
                state: state
            }
        ]
    };

    noohubMarkCommandActivity();

    noohubApiRequest(req, function(resp, raw) {
        if (noohubIsDeviceBusyResponse(resp, raw) && attempt < NOOHUB_SET_STATE_MAX_ATTEMPTS) {
            if (dev[vd + "/status"] !== undefined) {
                dev[vd + "/status"] = "busy, retry " + attempt;
            }

            noohubSetStatus("set_state busy, retry " + attempt + " for " + id);

            setTimeout(function() {
                noohubSendSetStateAttempt(id, state, attempt + 1);
            }, NOOHUB_SET_STATE_RETRY_DELAY_MS * attempt);

            return;
        }

        if (resp && resp.success === true) {
            if (noohubApplyLocalStateFromCommand(id, state, "sent, local")) {
                return;
            }

            if (dev[vd + "/last_update"] !== undefined) {
                dev[vd + "/last_update"] = noohubNowString();
            }

            if (dev[vd + "/status"] !== undefined) {
                dev[vd + "/status"] = "sent";
            }

            return;
        }

        if (dev[vd + "/status"] !== undefined) {
            dev[vd + "/status"] = "send failed";
        }

        noohubSetStatus("set_state failed for " + id + ": " + noohubShortRawForStatus(raw));
    }, true);
}


// -----------------------------------------------------------------------------
// Meta / diagnostic update
// -----------------------------------------------------------------------------

function noohubAddPublishValueCommand(commands, topic, value) {
    var v = "";

    if (value !== undefined && value !== null) {
        v = String(value);
    }

    if (v === "") {
        v = "n/a";
    }

    commands.push(
        "mosquitto_pub -r -t " + noohubShellQuote(topic) +
        " -m " + noohubShellQuote(v)
    );
}

function noohubAddPublishRawValueCommand(commands, topic, value) {
    var v = "";

    if (value !== undefined && value !== null) {
        v = String(value);
    }

    commands.push(
        "mosquitto_pub -r -t " + noohubShellQuote(topic) +
        " -m " + noohubShellQuote(v)
    );
}

function noohubAddPublishMetaCommand(commands, topic, metaObj) {
    noohubAddPublishValueCommand(commands, topic, JSON.stringify(metaObj));
}

function noohubAddDeleteRetainedCommand(commands, topic) {
    commands.push("mosquitto_pub -r -n -t " + noohubShellQuote(topic));
}

function noohubBuildDeleteRetainedTreeCommand(prefix, host, port) {
    var sub = "mosquitto_sub";
    var pub = "mosquitto_pub";

    if (host) {
        sub += " -h " + noohubShellQuote(host);
        pub += " -h " + noohubShellQuote(host);
    }

    if (port) {
        sub += " -p " + parseInt(port, 10);
        pub += " -p " + parseInt(port, 10);
    }

    return "{ printf '%s\\n' " + noohubShellQuote(prefix) + "; " +
        sub + " -W 1 -v -t " + noohubShellQuote(prefix + "/#") +
        " 2>/dev/null | awk '{print $1}'; } | sort -u | " +
        "awk '{s=$0; depth=gsub(/\\//, \"/\", s); print depth \" \" $0}' | sort -rn | cut -d' ' -f2- | " +
        "while IFS= read -r topic; do " +
        "if [ -n \"$topic\" ]; then " +
        pub + " -r -n -t \"$topic\"; " +
        "fi; " +
        "done";
}

function noohubDeleteRetainedTopicsForDeviceId(id) {
    if (!id) {
        return;
    }

    var vd = "noohub_" + id;
    var commands = [
        noohubBuildDeleteRetainedTreeCommand("/devices/" + vd, "", 0),
        noohubBuildDeleteRetainedTreeCommand(
            "/devices/" + vd,
            "127.0.0.1",
            noohubSprutHubMqttPortApplied || noohubSprutHubMqttPort
        ),
        noohubBuildDeleteRetainedTreeCommand(
            "/noohub/devices/" + vd,
            "127.0.0.1",
            noohubSprutHubMqttPortApplied || noohubSprutHubMqttPort
        )
    ];

    noohubRun(commands.join(" && "), function(exitCode, output) {
        if (exitCode === 0) {
            noohubLog("retained MQTT topics deleted for removed device: " + vd);
        } else {
            noohubLog("retained MQTT cleanup failed for removed device: " + vd);
            if (output) {
                noohubLog("retained cleanup output: " + output.substr(0, 300));
            }
        }
    });
}

function noohubDeleteSprutHubTopicsForDeviceId(id) {
    if (!id) {
        return;
    }

    var vd = "noohub_" + id;
    var commands = [
        noohubBuildDeleteRetainedTreeCommand("/devices/" + vd + "/meta/spruthub_template", "", 0),
        noohubBuildDeleteRetainedTreeCommand(
            "/devices/" + vd,
            "127.0.0.1",
            noohubSprutHubMqttPortApplied || noohubSprutHubMqttPort
        ),
        noohubBuildDeleteRetainedTreeCommand(
            "/noohub/devices/" + vd,
            "127.0.0.1",
            noohubSprutHubMqttPortApplied || noohubSprutHubMqttPort
        )
    ];

    noohubRun(commands.join(" && "), function(exitCode, output) {
        if (exitCode === 0) {
            noohubLog("SprutHub MQTT topics deleted for filtered device: " + vd);
        } else {
            noohubLog("SprutHub MQTT cleanup failed for filtered device: " + vd);
            if (output) {
                noohubLog("SprutHub cleanup output: " + output.substr(0, 300));
            }
        }
    });
}

function noohubSprutHubTemplateType(d) {
    if (!noohubIsDeviceAllowedForSprutHub(d)) {
        return "";
    }

    var controls = d && d.controls ? d.controls : [];

    if (controls.indexOf("on_button") >= 0 || controls.indexOf("pulse") >= 0) {
        return "impulse";
    }

    if (controls.indexOf("brightness") >= 0 && controls.indexOf("on") >= 0) {
        return "dimmer";
    }

    if (controls.indexOf("on") >= 0) {
        return "switch";
    }

    return "";
}

function noohubAddSprutHubTemplateMarkerCommands(commands, d) {
    var vd = "noohub_" + d.id;
    var selected = noohubSprutHubTemplateType(d);
    var types = NOOHUB_SPRUTHUB_TEMPLATE_TYPES;

    noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/meta/spruthub_type", selected || "none");

    for (var i = 0; i < types.length; i++) {
        var topic = "/devices/" + vd + "/meta/spruthub_template/" + types[i];

        if (types[i] === selected) {
            noohubAddPublishValueCommand(commands, topic, "1");
        } else {
            noohubAddDeleteRetainedCommand(commands, topic);
        }
    }
}

function noohubAddDiagnosticMetaAndValueCommands(commands, vd, controlName, title, type, value, order, readonly) {
    var meta = {
        order: order,
        readonly: readonly === false ? false : true,
        title: {
            en: title
        },
        type: type
    };

    noohubAddPublishMetaCommand(commands, "/devices/" + vd + "/controls/" + controlName + "/meta", meta);

    noohubAddPublishValueCommand(commands, "/devices/" + vd + "/controls/" + controlName, value);
}

function noohubAddControlMetaAndValueCommands(commands, vd, controlName, meta, value, publishValue) {
    noohubAddPublishMetaCommand(commands, "/devices/" + vd + "/controls/" + controlName + "/meta", meta);

    if (publishValue !== false) {
        noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/controls/" + controlName, value);
    }
}

function noohubAddVirtualControlPublishCommands(commands, d) {
    if (!d || !d.id) {
        return;
    }

    var vd = "noohub_" + d.id;
    var controls = d.controls || noohubGetControlsForDevice(d);

    if (controls.indexOf("on") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "on", {
            order: 1,
            readonly: false,
            title: { en: "On" },
            type: "switch"
        }, "0");
    }

    if (controls.indexOf("on_button") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "on", {
            order: 1,
            readonly: false,
            title: { en: "On / Impulse" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("brightness") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "brightness", {
            max: 100,
            min: 0,
            order: 2,
            readonly: false,
            title: { en: "Brightness" },
            type: "range"
        }, "0");
    }

    if (controls.indexOf("pulse") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "pulse", {
            order: 3,
            readonly: false,
            title: { en: "Pulse" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("switch") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "switch", {
            order: 4,
            readonly: false,
            title: { en: "Switch / Toggle" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("percent_open") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "percent_open", {
            max: 100,
            min: 0,
            order: 5,
            readonly: false,
            title: { en: "Percent Open" },
            type: "range"
        }, "0");
    }

    if (controls.indexOf("open_close") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "open_close", {
            order: 6,
            readonly: false,
            title: { en: "Open / Close" },
            type: "switch"
        }, "0");
    }

    if (controls.indexOf("pause") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "pause", {
            order: 7,
            readonly: false,
            title: { en: "Pause" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("open") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "open", {
            order: 7.1,
            readonly: false,
            title: { en: "Open" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("close") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "close", {
            order: 7.2,
            readonly: false,
            title: { en: "Close" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("speed_mode_switch") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "speed_mode_switch", {
            order: 8,
            readonly: false,
            title: { en: "Speed Mode Switch" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("switch_color") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "switch_color", {
            order: 9,
            readonly: false,
            title: { en: "Switch Color" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("overflow_color") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "overflow_color", {
            order: 10,
            readonly: false,
            title: { en: "Overflow Color" },
            type: "pushbutton"
        }, "0");
    }

    if (controls.indexOf("thermostat") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "thermostat", {
            order: 11,
            readonly: false,
            title: { en: "Thermostat" },
            type: "text"
        }, "");
    }

    if (controls.indexOf("color") >= 0) {
        noohubAddControlMetaAndValueCommands(commands, vd, "color", {
            order: 12,
            readonly: false,
            title: { en: "Color" },
            type: "text"
        }, "");
    }

    noohubAddDeleteRetainedCommand(commands, "/devices/" + vd + "/controls/spruthub_type");
    noohubAddDeleteRetainedCommand(commands, "/devices/" + vd + "/controls/spruthub_type/meta");

    noohubAddControlMetaAndValueCommands(commands, vd, "last_update", {
        order: 90,
        readonly: true,
        title: { en: "Last Update" },
        type: "text"
    }, "");

    noohubAddControlMetaAndValueCommands(commands, vd, "status", {
        order: 91,
        readonly: true,
        title: { en: "Status" },
        type: "text"
    }, "");
}

function noohubAddAllDiagnosticPublishCommands(commands, d) {
    var vd = "noohub_" + d.id;

    if (noohubIsDeviceInfoVisible("info_id")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "info_id", "NooHub ID", "text", d.id, 70, true);
    }

    if (noohubIsDeviceInfoVisible("info_name")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "info_name", "Name", "text", d.name, 71, true);
    }

    if (noohubIsDeviceInfoVisible("info_room")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "info_room", "Room", "text", d.room, 72, true);
    }

    if (noohubIsDeviceInfoVisible("info_model")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "info_model", "Model", "text", d.model, 73, true);
    }

    if (noohubIsDeviceInfoVisible("info_type")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "info_type", "Type", "text", d.type, 74, true);
    }

    if (noohubIsDeviceInfoVisible("info_subtype")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "info_subtype", "Subtype", "text", d.subtype, 75, true);
    }

    if (noohubIsDeviceInfoVisible("info_protocol")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "info_protocol", "Protocol", "text", d.protocol, 76, true);
    }

    if (noohubIsDeviceInfoVisible("mtrf_ch")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "mtrf_ch", "MTRF Ch", "text", d.ch, 77, true);
    }

    if (noohubIsDeviceInfoVisible("noolite_mode")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "noolite_mode", "NooLite Mode", "text", d.noolite_mode_text, 78, true);
    }

    if (noohubIsDeviceInfoVisible("retrievable")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "retrievable", "Retrievable", "switch", d.retrievable ? "1" : "0", 79, true);
    }

    if (noohubIsDeviceInfoVisible("reportable")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "reportable", "Reportable", "switch", d.reportable ? "1" : "0", 80, true);
    }

    if (noohubIsDeviceInfoVisible("skills")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "skills", "Skills", "text", d.skills_text, 81, true);
    }

    if (noohubIsDeviceInfoVisible("sensors")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "sensors", "Sensors", "text", d.sensors_text, 82, true);
    }

    if (noohubIsDeviceInfoVisible("events")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "events", "Events", "text", d.events_text, 83, true);
    }

    if (noohubIsDeviceInfoVisible("raw_json")) {
        noohubAddDiagnosticMetaAndValueCommands(commands, vd, "raw_json", "Raw JSON", "text", d.raw_json, 84, true);
    }
}

function noohubUpdateDeviceMetaOnly(d) {
    if (!d || !d.id) {
        return;
    }

    var vd = "noohub_" + d.id;
    var title = noohubMakeDeviceTitle(d);

    var commands = [];

    var metaJson = {
        driver: "wb-rules",
        title: {
            en: title
        }
    };

    noohubAddPublishValueCommand(commands, "/devices/" + vd + "/meta/name", title);
    noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/meta/room", d.room);
    noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/meta/noohub_name", d.name);
    noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/meta/noohub_room", d.room);
    noohubAddPublishMetaCommand(commands, "/devices/" + vd + "/meta", metaJson);

    noohubAddSprutHubTemplateMarkerCommands(commands, d);
    noohubAddVirtualControlPublishCommands(commands, d);
    noohubAddAllDiagnosticPublishCommands(commands, d);

    noohubRun(commands.join(" && "), function(exitCode, output) {
        if (exitCode === 0) {
            noohubLog("device meta/diagnostics updated: " + vd + " -> " + title);
        } else {
            noohubLog("device meta/diagnostics update failed: " + vd);
        }
    });
}

function noohubUpdateDeviceSprutHubMarkersOnly(d) {
    if (!d || !d.id) {
        return;
    }

    var vd = "noohub_" + d.id;
    var title = noohubMakeDeviceTitle(d);
    var commands = [];

    noohubAddPublishValueCommand(commands, "/devices/" + vd + "/meta/name", title);
    noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/meta/room", d.room);
    noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/meta/noohub_name", d.name);
    noohubAddPublishRawValueCommand(commands, "/devices/" + vd + "/meta/noohub_room", d.room);
    noohubAddSprutHubTemplateMarkerCommands(commands, d);
    noohubAddVirtualControlPublishCommands(commands, d);

    if (commands.length === 0) {
        return;
    }

    noohubRun(commands.join(" && "), function(exitCode, output) {
        if (exitCode === 0) {
            noohubLog("SprutHub markers updated: noohub_" + d.id);
        } else {
            noohubLog("SprutHub markers update failed: noohub_" + d.id);
        }
    }, true);
}

function noohubUpdateAllSprutHubMarkers() {
    if (!noohubDevices || noohubDevices.length === 0) {
        return;
    }

    for (var i = 0; i < noohubDevices.length; i++) {
        noohubUpdateDeviceSprutHubMarkersOnly(noohubDevices[i]);
    }
}

// -----------------------------------------------------------------------------
// One device resync
// -----------------------------------------------------------------------------

function noohubFindDeviceInNooHubList(id, list) {
    if (!id || !list) {
        return null;
    }

    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id || "") === String(id)) {
            return list[i];
        }
    }

    return null;
}

function noohubNormalizeChForCompare(ch) {
    var s = String(ch || "").replace(/\s+/g, "");

    if (!s) {
        return "";
    }

    if (/^\d+$/.test(s)) {
        return String(parseInt(s, 10));
    }

    return s.toLowerCase();
}

function noohubFindDeviceByChInNooHubList(ch, list) {
    if (ch === undefined || ch === null || !list) {
        return null;
    }

    var wanted = noohubNormalizeChForCompare(ch);

    if (!wanted) {
        return null;
    }

    for (var i = 0; i < list.length; i++) {
        if (!list[i]) {
            continue;
        }

        if (noohubNormalizeChForCompare(list[i].ch) === wanted) {
            return list[i];
        }
    }

    return null;
}

function noohubChListText(list) {
    var out = [];

    if (!list) {
        return "";
    }

    for (var i = 0; i < list.length; i++) {
        if (!list[i] || list[i].ch === undefined || list[i].ch === null || list[i].ch === "") {
            continue;
        }

        out.push(String(list[i].ch));

        if (out.length >= 20) {
            break;
        }
    }

    return out.join(", ");
}

function noohubParseResyncChList(input) {
    var out = [];
    var seen = {};
    var raw = String(input || "").replace(/;/g, ",");
    var parts = raw.split(",");

    function addCh(n) {
        if (isNaN(n) || n <= 0 || n > 999) {
            return;
        }

        var ch = String(n);

        if (!seen[ch]) {
            seen[ch] = true;
            out.push(ch);
        }
    }

    for (var i = 0; i < parts.length; i++) {
        var part = String(parts[i] || "").replace(/\s+/g, "");

        if (!part) {
            continue;
        }

        var range = part.match(/^0*([0-9]+)-0*([0-9]+)$/);

        if (range) {
            var start = parseInt(range[1], 10);
            var end = parseInt(range[2], 10);

            if (isNaN(start) || isNaN(end)) {
                continue;
            }

            if (start > end) {
                var tmp = start;
                start = end;
                end = tmp;
            }

            if (end - start > 100) {
                noohubLog("resync CH range too large, truncated to 100 channels: " + part);
                end = start + 100;
            }

            for (var n = start; n <= end; n++) {
                addCh(n);
            }

            continue;
        }

        var normalized = noohubNormalizeChForCompare(part);

        if (normalized) {
            addCh(parseInt(normalized, 10));
        }
    }

    return out;
}

function noohubAvailableChList(list) {
    var out = [];
    var seen = {};

    if (!list) {
        list = [];
    }

    for (var i = 0; i < list.length; i++) {
        if (!list[i] || list[i].ch === undefined || list[i].ch === null || list[i].ch === "") {
            continue;
        }

        var ch = noohubNormalizeChForCompare(list[i].ch);
        var n = parseInt(ch, 10);

        if (isNaN(n) || n <= 0 || seen[String(n)]) {
            continue;
        }

        seen[String(n)] = true;
        out.push(String(n));
    }

    out.sort(function(a, b) {
        return parseInt(a, 10) - parseInt(b, 10);
    });

    return out;
}

function noohubParseResyncChCommand(input, availableList) {
    var result = {
        deleteAll: false,
        channels: []
    };

    var out = [];
    var seen = {};
    var available = noohubAvailableChList(availableList);
    var raw = String(input || "").replace(/;/g, ",");
    var parts = raw.split(",");

    function addCh(n) {
        if (isNaN(n) || n <= 0 || n > 999) {
            return;
        }

        var ch = String(n);

        if (!seen[ch]) {
            seen[ch] = true;
            out.push(ch);
        }
    }

    function addAvailableRange(minValue, maxValue) {
        for (var i = 0; i < available.length; i++) {
            var n = parseInt(available[i], 10);

            if (!isNaN(minValue) && n < minValue) {
                continue;
            }

            if (!isNaN(maxValue) && n > maxValue) {
                continue;
            }

            addCh(n);
        }
    }

    for (var i = 0; i < parts.length; i++) {
        var part = String(parts[i] || "").replace(/\s+/g, "");

        if (!part) {
            continue;
        }

        if (part === "0>") {
            result.deleteAll = true;
            result.channels = [];
            return result;
        }

        var fromOpen = part.match(/^0*([0-9]+)>$/);

        if (fromOpen) {
            addAvailableRange(parseInt(fromOpen[1], 10), NaN);
            continue;
        }

        var toOpen = part.match(/^<0*([0-9]+)$/);

        if (toOpen) {
            addAvailableRange(NaN, parseInt(toOpen[1], 10));
            continue;
        }

        var range = part.match(/^0*([0-9]+)-0*([0-9]+)$/);

        if (range) {
            var start = parseInt(range[1], 10);
            var end = parseInt(range[2], 10);

            if (isNaN(start) || isNaN(end)) {
                continue;
            }

            if (start > end) {
                var tmp = start;
                start = end;
                end = tmp;
            }

            for (var n = start; n <= end; n++) {
                addCh(n);
            }

            continue;
        }

        var normalized = noohubNormalizeChForCompare(part);

        if (normalized) {
            addCh(parseInt(normalized, 10));
        }
    }

    result.channels = noohubFormatChList(out).split(/\s*,\s*/).filter(function(ch) {
        return ch !== "";
    });

    return result;
}

function noohubSprutHubChFilterList() {
    return noohubParseResyncChList(noohubSprutHubChFilter);
}

function noohubFormatChList(list) {
    var parsed = noohubParseResyncChList((list || []).join(","));

    parsed.sort(function(a, b) {
        return parseInt(a, 10) - parseInt(b, 10);
    });

    return parsed.join(", ");
}

function noohubMergeSprutHubChFilter(channels) {
    var merged = [];
    var seen = {};
    var current = noohubSprutHubChFilterList();
    var incoming = noohubParseResyncChList((channels || []).join(","));

    function add(ch) {
        var n = noohubNormalizeChForCompare(ch);

        if (!n || seen[n]) {
            return;
        }

        seen[n] = true;
        merged.push(n);
    }

    for (var i = 0; i < current.length; i++) {
        add(current[i]);
    }

    for (var j = 0; j < incoming.length; j++) {
        add(incoming[j]);
    }

    noohubSprutHubChFilter = noohubFormatChList(merged);
    dev[NOOHUB_SETTINGS_DEVICE + "/resync_ch"] = noohubSprutHubChFilter;

    return noohubSprutHubChFilter;
}

function noohubRemoveFromSprutHubChFilter(channels) {
    var remove = {};
    var current = noohubSprutHubChFilterList();
    var incoming = noohubParseResyncChList((channels || []).join(","));
    var kept = [];

    for (var i = 0; i < incoming.length; i++) {
        remove[noohubNormalizeChForCompare(incoming[i])] = true;
    }

    for (var j = 0; j < current.length; j++) {
        var normalized = noohubNormalizeChForCompare(current[j]);

        if (normalized && !remove[normalized]) {
            kept.push(normalized);
        }
    }

    noohubSprutHubChFilter = noohubFormatChList(kept);
    dev[NOOHUB_SETTINGS_DEVICE + "/resync_ch"] = noohubSprutHubChFilter;

    return noohubSprutHubChFilter;
}

function noohubIsDeviceAllowedForSprutHub(d) {
    var filter = noohubSprutHubChFilterList();

    if (filter.length === 0) {
        return true;
    }

    var wanted = {};
    for (var i = 0; i < filter.length; i++) {
        wanted[noohubNormalizeChForCompare(filter[i])] = true;
    }

    return !!wanted[noohubNormalizeChForCompare(d && d.ch)];
}

function noohubCleanupSprutHubTopicsOutsideFilter(list) {
    if (!list) {
        return;
    }

    for (var i = 0; i < list.length; i++) {
        var nd = noohubNormalizeDevice(list[i]);

        if (!nd.id || noohubIsDeviceAllowedForSprutHub(nd)) {
            continue;
        }

        noohubDeleteSprutHubTopicsForDeviceId(nd.id);
    }
}

function noohubCleanupSprutHubTopicsExceptAllowed(list, allowedIds) {
    var allowed = {};

    allowedIds = allowedIds || [];
    for (var i = 0; i < allowedIds.length; i++) {
        if (allowedIds[i]) {
            allowed[String(allowedIds[i])] = true;
        }
    }

    list = list || [];
    for (var j = 0; j < list.length; j++) {
        var nd = noohubNormalizeDevice(list[j]);

        if (!nd.id || allowed[nd.id]) {
            continue;
        }

        noohubDeleteSprutHubTopicsForDeviceId(nd.id);
    }
}

function noohubPruneSprutHubBrokerToAllowedIds(allowedIds) {
    allowedIds = noohubUniqueStringList(allowedIds || []);

    var host = "127.0.0.1";
    var port = noohubSprutHubMqttPortApplied || noohubSprutHubMqttPort;
    var sub = "mosquitto_sub -h " + noohubShellQuote(host) +
        " -p " + noohubShellQuote(port) +
        " -W 1 -v -t '/devices/#' -t '/noohub/devices/#'";
    var pub = "mosquitto_pub -h " + noohubShellQuote(host) +
        " -p " + noohubShellQuote(port);
    var command =
        "allowed=" + noohubShellQuote(allowedIds.join(" ")) + "; " +
        sub + " 2>/dev/null | awk '{print $1}' | sort -u | " +
        "awk '{s=$0; depth=gsub(/\\//, \"/\", s); print depth \" \" $0}' | sort -rn | cut -d' ' -f2- | " +
        "while IFS= read -r topic; do " +
        "id=$(printf '%s\\n' \"$topic\" | sed -n 's#^/devices/noohub_\\([^/]*\\).*#\\1#p; s#^/noohub/devices/noohub_\\([^/]*\\).*#\\1#p'); " +
        "if [ -z \"$id\" ]; then continue; fi; " +
        "case \" $allowed \" in *\" $id \"*) ;; *) " +
        pub + " -r -n -t \"$topic\"; " +
        "esac; " +
        "done";

    noohubRun(command, function(exitCode, output) {
        if (exitCode === 0) {
            noohubLog("SprutHub MQTT broker pruned to allowed ids: " + (allowedIds.join(",") || "none"));
        } else {
            noohubLog("SprutHub MQTT broker prune failed");
            if (output) {
                noohubLog("SprutHub prune output: " + output.substr(0, 300));
            }
        }
    });
}

function noohubReplaceOneDeviceInMemoryAndFile(newDevice, callback) {
    if (!newDevice || !newDevice.id) {
        if (callback) {
            callback(false);
        }
        return;
    }

    var replaced = false;
    var newList = [];
    var newById = {};

    for (var i = 0; i < noohubDevices.length; i++) {
        if (String(noohubDevices[i].id) === String(newDevice.id)) {
            noohubCarryDeviceOverrides(newDevice, noohubDevices[i]);
            newList.push(newDevice);
            newById[newDevice.id] = newDevice;
            replaced = true;
        } else {
            newList.push(noohubDevices[i]);
            newById[noohubDevices[i].id] = noohubDevices[i];
        }
    }

    if (!replaced) {
        newList.push(newDevice);
        newById[newDevice.id] = newDevice;
    }

    noohubDevices = newList;
    noohubDeviceById = newById;

    dev[NOOHUB_SETTINGS_DEVICE + "/devices_count"] = noohubDevices.length;

    noohubSaveDevicesToFile(function(ok) {
        if (callback) {
            callback(ok);
        }
    });
}

function noohubReplaceDevicesInMemoryAndFile(newDevicesToUpsert, callback) {
    var upsertById = {};
    var changedCount = 0;

    newDevicesToUpsert = newDevicesToUpsert || [];
    for (var i = 0; i < newDevicesToUpsert.length; i++) {
        if (newDevicesToUpsert[i] && newDevicesToUpsert[i].id && !upsertById[newDevicesToUpsert[i].id]) {
            upsertById[newDevicesToUpsert[i].id] = newDevicesToUpsert[i];
            changedCount++;
        }
    }

    if (changedCount === 0) {
        if (callback) {
            callback(true);
        }
        return;
    }

    var nextList = [];
    var nextById = {};
    var consumed = {};

    for (var j = 0; j < noohubDevices.length; j++) {
        var old = noohubDevices[j];

        if (!old || !old.id) {
            continue;
        }

        if (upsertById[old.id]) {
            noohubCarryDeviceOverrides(upsertById[old.id], old);
            nextList.push(upsertById[old.id]);
            nextById[old.id] = upsertById[old.id];
            consumed[old.id] = true;
        } else {
            nextList.push(old);
            nextById[old.id] = old;
        }
    }

    for (var id in upsertById) {
        if (upsertById.hasOwnProperty(id) && !consumed[id]) {
            nextList.push(upsertById[id]);
            nextById[id] = upsertById[id];
        }
    }

    noohubDevices = nextList;
    noohubDeviceById = nextById;
    dev[NOOHUB_SETTINGS_DEVICE + "/devices_count"] = noohubDevices.length;

    noohubSaveDevicesToFile(function(ok) {
        if (callback) {
            callback(ok);
        }
    });
}

function noohubRunOneDeviceResyncScript(id) {
    if (!id) {
        return;
    }

    var unit = "noohub-resync-one-" + id + "-" + new Date().getTime();

    var cmd =
        "systemd-run --unit=" + unit +
        " --collect " +
        noohubShellQuote(NOOHUB_RESYNC_SELECTED_SCRIPT) +
        " " + noohubShellQuote(id);

    noohubSetStatus("resync one device started: " + id);

    noohubRun(cmd, function(exitCode, output) {
        noohubLog("resync one device systemd-run exit: " + exitCode);

        if (output) {
            noohubLog("resync one device output: " + output.substr(0, 300));
        }
    });
}

function noohubRunSelectedDevicesCleanupScript(ids, reason, deleteMode) {
    if (!ids || ids.length === 0) {
        return;
    }

    var unit = "noohub-selected-cleanup-" + new Date().getTime();
    var cmd =
        "systemd-run --unit=" + unit +
        " --collect " +
        noohubShellQuote(NOOHUB_RESYNC_SELECTED_SCRIPT);

    if (deleteMode) {
        cmd += " --delete-mode";
    }

    for (var i = 0; i < ids.length; i++) {
        cmd += " " + noohubShellQuote(ids[i]);
    }

    noohubSetStatus((reason || "selected cleanup") + " started: " + ids.join(","));

    noohubRun(cmd, function(exitCode, output) {
        noohubLog("selected cleanup systemd-run exit: " + exitCode);

        if (output) {
            noohubLog("selected cleanup output: " + output.substr(0, 300));
        }
    });
}

function noohubResyncOneDeviceFromNooHub(id) {
    if (!id) {
        noohubSetStatus("resync one failed: empty id");
        return;
    }

    noohubSetStatus("resync one requested: " + id);

    noohubApiRequest(noohubBuildGetDevicesRequest(), function(resp, raw) {
        if (!noohubIsGoodDevicesResponse(resp)) {
            noohubSetStatus("resync one failed: " + noohubDevicesResponseErrorText(raw));
            return;
        }

        var src = noohubFindDeviceInNooHubList(id, resp.devices || []);

        if (!src) {
            noohubSetStatus("resync one failed: device not found " + id);
            return;
        }

        var nd = noohubNormalizeDevice(src);

        if (!nd.id) {
            noohubSetStatus("resync one failed: bad device data");
            return;
        }

        noohubReplaceOneDeviceInMemoryAndFile(nd, function(ok) {
            if (!ok) {
                noohubSetStatus("resync one failed: save file error " + id);
                return;
            }

            noohubSetStatus("resync one saved, recreating card: " + id);

            noohubRunOneDeviceResyncScript(id);
        });
    });
}

function noohubResyncOneDeviceByChFromNooHub(ch) {
    var normalizedCh = noohubNormalizeChForCompare(ch);

    if (!normalizedCh) {
        noohubSetStatus("resync CH failed: empty CH");
        return;
    }

    noohubSetStatus("resync CH requested: " + normalizedCh);

    noohubApiGetAllDevicesWithFallback(function(resp, raw) {
        if (!noohubIsGoodDevicesResponse(resp)) {
            noohubSetStatus("resync CH failed: " + noohubDevicesResponseErrorText(raw));
            return;
        }

        var src = noohubFindDeviceByChInNooHubList(normalizedCh, resp.devices || []);

        if (!src) {
            var knownCh = noohubChListText(resp.devices || []);
            noohubSetStatus("resync CH failed: device not found CH " + normalizedCh + ". Known CH: " + (knownCh || "none"));
            return;
        }

        var nd = noohubNormalizeDevice(src);

        if (!nd.id) {
            noohubSetStatus("resync CH failed: bad device data CH " + normalizedCh);
            return;
        }

        noohubReplaceOneDeviceInMemoryAndFile(nd, function(ok) {
            if (!ok) {
                noohubSetStatus("resync CH failed: save file error CH " + normalizedCh);
                return;
            }

            noohubSetStatus("resync CH saved, recreating card: CH " + normalizedCh + ", id " + nd.id);

            noohubRunOneDeviceResyncScript(nd.id);
        });
    });
}

function noohubResyncChListFromNooHub(input, knownDevices) {
    var channels = noohubParseResyncChList(input);

    if (channels.length === 0) {
        noohubSetStatus("resync CH failed: empty CH list");
        return;
    }

    function processList(list) {
        var found = [];
        var missing = [];
        var devicesToSave = [];

        for (var index = 0; index < channels.length; index++) {
            var ch = channels[index];
            var src = noohubFindDeviceByChInNooHubList(ch, list);

            if (!src) {
                missing.push(ch);
                continue;
            }

            var nd = noohubNormalizeDevice(src);

            if (!nd.id) {
                missing.push(ch);
                continue;
            }

            devicesToSave.push(nd);
            found.push(nd.id);
        }

        noohubReplaceDevicesInMemoryAndFile(devicesToSave, function(ok) {
            var status =
                "resync CH list complete: found=" + found.length +
                ", missing=" + missing.length;

            if (found.length > 0) {
                status += ", ids=" + found.join(",");
            }

            if (missing.length > 0) {
                status += ", missing CH=" + missing.join(",");
            }

            if (!ok) {
                status += ", save failed";
                noohubSetStatus(status);
                return;
            }

            noohubSetStatus(status);

            if (found.length > 0) {
                noohubRunSelectedDevicesCleanupScript(found, "resync CH list");
            }
        });
    }

    noohubSetStatus("resync CH list requested: " + channels.join(", "));

    if (knownDevices) {
        processList(knownDevices || []);
        return;
    }

    noohubApiGetAllDevicesWithFallback(function(resp, raw) {
        if (!noohubIsGoodDevicesResponse(resp)) {
            noohubSetStatus("resync CH list failed: " + noohubDevicesResponseErrorText(raw));
            return;
        }

        processList(resp.devices || []);
    });
}

function noohubSyncOrResyncFromInput() {
    if (noohubDeleteBusyUntil && new Date().getTime() < noohubDeleteBusyUntil) {
        noohubSetStatus("delete cleanup is still running; wait before resync");
        return;
    }

    var input = String(dev[NOOHUB_SETTINGS_DEVICE + "/resync_ch"] || "");
    var compactInput = input.replace(/\s+/g, "");

    if (compactInput === "") {
        noohubScanDevices();
        return;
    }

    if (compactInput === "0>") {
        noohubSetStatus("sync command 0>: clear SprutHub filter and sync current get_devices type");
        dev[NOOHUB_SETTINGS_DEVICE + "/resync_ch"] = "";
        noohubSprutHubChFilter = "";
        noohubSaveSettings(true);
        noohubApplySprutHubProxyAllowedIds([], false, function(ok) {
            if (!ok) {
                noohubSetStatus("sync command 0>: proxy ALL failed, sync continues");
            }

            noohubScanDevices();
        });
        return;
    }

    noohubSetStatus("Sync command requested: " + input);

    noohubApiGetAllDevicesWithFallback(function(resp, raw) {
        if (!noohubIsGoodDevicesResponse(resp)) {
            noohubSetStatus("sync command failed: " + noohubDevicesResponseErrorText(raw));
            return;
        }

        var command = noohubParseResyncChCommand(input, resp.devices || []);

        if (command.deleteAll) {
            noohubSetStatus("sync command 0>: clear SprutHub filter and sync current get_devices type");
            dev[NOOHUB_SETTINGS_DEVICE + "/resync_ch"] = "";
            noohubSprutHubChFilter = "";
            noohubSaveSettings(true);
            noohubApplySprutHubProxyAllowList(resp.devices || [], false, function(ok) {
                noohubScanDevices();
            });
            return;
        }

        if (command.channels.length === 0) {
            noohubSetStatus("sync command failed: no matching CH");
            return;
        }

        var selectedDevices = noohubFindDevicesByChannelsInNooHubList(command.channels, resp.devices || []);

        if (selectedDevices.length === 0) {
            noohubSetStatus("sync command failed: selected CH not found in NooHub");
            return;
        }

        noohubMergeSprutHubChFilter(command.channels);
        noohubSaveSettings(true);

        var proxyState = noohubSprutHubProxyStateFromDeviceList(
            (resp.devices || []).concat(noohubDevices || []),
            true
        );
        var allowedIds = proxyState.allowedIds;

        noohubPruneSprutHubBrokerToAllowedIds(allowedIds);
        noohubApplySprutHubProxyAllowedIds(allowedIds, proxyState.blockAll, function(ok) {
            noohubSetStatus(
                "Sync uses Resync CH list; SprutHub filter now: " +
                noohubSprutHubChFilter
            );
            noohubResyncChListFromNooHub(command.channels.join(","), resp.devices || []);
        });
    });
}

function noohubDeleteAllKnownChannels() {
    var ids = noohubDeviceIdsFromList(noohubDevices);

    noohubDeleteBusyUntil = new Date().getTime() + 30000;
    dev[NOOHUB_SETTINGS_DEVICE + "/polling_enabled"] = false;
    dev[NOOHUB_SETTINGS_DEVICE + "/delete_ch"] = "";
    dev[NOOHUB_SETTINGS_DEVICE + "/resync_ch"] = "";
    noohubSprutHubChFilter = "";

    noohubDevices = [];
    noohubDeviceById = {};
    dev[NOOHUB_SETTINGS_DEVICE + "/devices_count"] = 0;
    noohubSaveSettings(true);

    noohubSaveDevicesToFile(function(ok) {
        var status =
            "delete command 0>: selected cleanup started, deleted=" + ids.length;

        if (!ok) {
            status += ", save failed";
        }

        noohubApplySprutHubProxyAllowedIds([], true, function(proxyOk) {
            if (!proxyOk) {
                status += ", proxy failed";
            }

            if (ids.length > 0) {
                noohubRunSelectedDevicesCleanupScript(ids, "delete all CH", true);
            } else {
                status = "delete command 0>: no saved NooHub devices";
            }

            noohubSetStatus(status);
        });
    });
}

function noohubDeleteChannelsFromInput() {
    if (noohubDeleteBusyUntil && new Date().getTime() < noohubDeleteBusyUntil) {
        noohubSetStatus("delete cleanup already running");
        return;
    }

    var input = String(dev[NOOHUB_SETTINGS_DEVICE + "/delete_ch"] || "");
    var compactInput = input.replace(/\s+/g, "");

    if (compactInput === "") {
        noohubSetStatus("delete CH failed: empty Delete CH list. Use 0> for full delete.");
        return;
    }

    if (compactInput === "0>") {
        noohubSetStatus("delete command 0>: selected cleanup for all saved devices");
        noohubDeleteAllKnownChannels();
        return;
    }

    noohubSetStatus("delete command requested: " + input);

    noohubApiGetAllDevicesWithFallback(function(resp, raw) {
        if (!noohubIsGoodDevicesResponse(resp)) {
            noohubSetStatus("delete command failed: " + noohubDevicesResponseErrorText(raw));
            return;
        }

        var command = noohubParseResyncChCommand(input, resp.devices || []);

        if (command.deleteAll) {
            noohubSetStatus("delete command 0>: selected cleanup for all saved devices");
            noohubDeleteAllKnownChannels();
            return;
        }

        if (command.channels.length === 0) {
            noohubSetStatus("delete command failed: no matching CH");
            return;
        }

        noohubDeleteChannels(command.channels, resp.devices || []);
    });
}

function noohubDeleteChannels(channels, apiDevices) {
    noohubSetStatus("delete CH requested: " + channels.join(", "));
    noohubDeleteBusyUntil = new Date().getTime() + 30000;

    var byCh = {};
    var ids = [];
    var missing = [];
    var newDevices = [];
    var newById = {};

    for (var i = 0; i < noohubDevices.length; i++) {
        if (!noohubDevices[i]) {
            continue;
        }

        byCh[noohubNormalizeChForCompare(noohubDevices[i].ch)] = noohubDevices[i];
    }

    apiDevices = apiDevices || [];

    for (var apiIndex = 0; apiIndex < apiDevices.length; apiIndex++) {
        var apiDevice = noohubNormalizeDevice(apiDevices[apiIndex]);
        var apiCh = noohubNormalizeChForCompare(apiDevice.ch);

        if (apiDevice.id && apiCh && !byCh[apiCh]) {
            byCh[apiCh] = apiDevice;
        }
    }

    for (var j = 0; j < channels.length; j++) {
        var found = byCh[noohubNormalizeChForCompare(channels[j])];

        if (found && found.id) {
            ids.push(found.id);
        } else {
            missing.push(channels[j]);
        }
    }

    var removeById = {};
    for (var k = 0; k < ids.length; k++) {
        removeById[String(ids[k])] = true;
    }

    for (var n = 0; n < noohubDevices.length; n++) {
        if (!noohubDevices[n] || removeById[String(noohubDevices[n].id)]) {
            continue;
        }

        newDevices.push(noohubDevices[n]);
        newById[noohubDevices[n].id] = noohubDevices[n];
    }

    noohubDevices = newDevices;
    noohubDeviceById = newById;
    dev[NOOHUB_SETTINGS_DEVICE + "/devices_count"] = noohubDevices.length;
    noohubRemoveFromSprutHubChFilter(channels);
    dev[NOOHUB_SETTINGS_DEVICE + "/delete_ch"] = "";

    noohubSaveSettings(true);
    var proxyState = noohubSprutHubProxyStateFromDeviceList(noohubDevices, true);
    var allowedIds = proxyState.allowedIds;

    noohubSaveDevicesToFile(function(ok) {
        var status =
            "delete CH cleanup started: deleted=" + ids.length +
            ", missing=" + missing.length +
            ". Refresh WB page if empty cards remain";

        if (missing.length > 0) {
            status += ", missing CH=" + missing.join(",");
        }

        if (!ok) {
            status += ", save failed";
        }

        noohubApplySprutHubProxyAllowedIds(allowedIds, proxyState.blockAll, function(proxyOk) {
            if (!proxyOk) {
                status += ", proxy failed";
            }

            if (ids.length > 0) {
                noohubRunSelectedDevicesCleanupScript(ids, "delete CH", true);
            }

            noohubSetStatus(status);
        });
    });
}


// -----------------------------------------------------------------------------
// Safe Sync / Scan Devices
// -----------------------------------------------------------------------------

function noohubScanDevices() {
    if (noohubDeleteBusyUntil && new Date().getTime() < noohubDeleteBusyUntil) {
        noohubSetStatus("delete cleanup is still running; wait before sync");
        return;
    }

    if (noohubScanBusy) {
        if (noohubIsScanBusyExpired()) {
            noohubResetScanBusy("timeout before new sync");
        } else {
            noohubSetStatus("sync already running");
            return;
        }
    }

    noohubScanBusy = true;
    noohubScanBusyStartedAt = new Date().getTime();

    noohubSetStatus("sync started");

    noohubApiRequest(noohubBuildGetDevicesRequest(), function(resp, raw) {
        noohubResetScanBusy("api response received");

        if (!noohubIsGoodDevicesResponse(resp)) {
            noohubSetStatus("sync failed: " + noohubDevicesResponseErrorText(raw));
            return;
        }

        var list = resp.devices || [];

        var oldById = {};
        for (var i = 0; i < noohubDevices.length; i++) {
            if (noohubDevices[i] && noohubDevices[i].id) {
                oldById[noohubDevices[i].id] = noohubDevices[i];
            }
        }

        var newDevices = [];
        var newById = {};

        var addedCount = 0;
        var metaChangedCount = 0;
        var controlsChangedCount = 0;
        var removedCount = 0;
        var unchangedCount = 0;

        var seenIds = {};

        for (var j = 0; j < list.length; j++) {
            var nd = noohubNormalizeDevice(list[j]);

            if (!nd.id) {
                continue;
            }

            if (nd.id === noohubId) {
                noohubLog("skip controller id: " + nd.id);
                continue;
            }

            seenIds[nd.id] = true;

            var old = oldById[nd.id];

            if (old) {
                noohubCarryDeviceOverrides(nd, old);
            }

            newDevices.push(nd);
            newById[nd.id] = nd;

            if (!noohubIsDeviceAllowedForSprutHub(nd)) {
                noohubDeleteSprutHubTopicsForDeviceId(nd.id);
            }

            if (!old) {
                addedCount++;
                noohubLog("new device found: " + nd.id);
                noohubCreateVirtualDevice(nd);
                noohubUpdateDeviceMetaOnly(nd);
                continue;
            }

            if (noohubDeviceControlsChanged(old, nd)) {
                controlsChangedCount++;
                noohubLog("device controls changed, saved only. Use Resync CH for CH " + nd.ch + ": " + nd.id);
                noohubUpdateDeviceMetaOnly(nd);
                continue;
            }

            if (noohubDeviceMetaChanged(old, nd)) {
                metaChangedCount++;
                noohubLog("device meta/diagnostics changed: " + nd.id);
                noohubUpdateDeviceMetaOnly(nd);
                continue;
            }

            noohubUpdateDeviceSprutHubMarkersOnly(nd);
            unchangedCount++;
        }

        for (var oldId in oldById) {
            if (oldById.hasOwnProperty(oldId)) {
                if (!seenIds[oldId]) {
                    removedCount++;
                    noohubLog("device removed from NooHub, deleting retained MQTT topics: " + oldId);
                    noohubDeleteRetainedTopicsForDeviceId(oldId);
                }
            }
        }

        noohubDevices = newDevices;
        noohubDeviceById = newById;

        dev[NOOHUB_SETTINGS_DEVICE + "/devices_count"] = noohubDevices.length;
        dev[NOOHUB_SETTINGS_DEVICE + "/last_scan"] = noohubNowString();

        noohubSaveDevicesToFile(function(ok) {
            var proxyState = noohubSprutHubProxyStateFromDeviceList(noohubDevices, true);
            var status =
                "sync complete: total=" + noohubDevices.length +
                ", added=" + addedCount +
                ", meta=" + metaChangedCount +
                ", controls_changed=" + controlsChangedCount +
                ", removed_seen=" + removedCount +
                ", unchanged=" + unchangedCount;

            if (!ok) {
                noohubSetStatus(status + ", save failed");
                return;
            }

            noohubPruneSprutHubBrokerToAllowedIds(proxyState.allowedIds);
            noohubApplySprutHubProxyAllowedIds(proxyState.allowedIds, proxyState.blockAll, function(proxyOk) {
                if (!proxyOk) {
                    status += ", SprutHub proxy failed";
                }

                if (controlsChangedCount > 0) {
                    noohubSetStatus(status + ". Use Resync CH for changed cards.");
                } else {
                    noohubSetStatus(status);
                }
            });
        });
    });
}


// -----------------------------------------------------------------------------
// Polling
// -----------------------------------------------------------------------------

function noohubApplyStateResponse(id, resp) {
    var vd = "noohub_" + id;
    var state = null;

    if (resp.devices && resp.devices.length > 0) {
        var rd = resp.devices[0] || {};

        if (rd.no_device) {
            if (dev[vd + "/status"] !== undefined) {
                noohubSetDevIfChanged(vd + "/status", "poll failed: no_device");
            }
            return;
        }

        if (rd.state !== undefined) {
            state = rd.state;
        } else {
            state = rd;
        }
    } else if (resp.state !== undefined) {
        state = resp.state;
    }

    if (state === false) {
        if (dev[vd + "/status"] !== undefined) {
            noohubSetDevIfChanged(vd + "/status", "poll failed: state unavailable");
        }
        return;
    }

    if (!state) {
        return;
    }

    noohubSetUpdatingFromPoll(true);

    try {
        if (state.on !== undefined && dev[vd + "/on"] !== undefined) {
            noohubSetDevIfChanged(vd + "/on", !!state.on);
        }

        if (state.brightness !== undefined && dev[vd + "/brightness"] !== undefined) {
            var b = parseInt(state.brightness, 10);

            if (isNaN(b)) {
                b = 0;
            }

            noohubSetDevIfChanged(vd + "/brightness", b);
        }

        if (state.percent_open !== undefined && dev[vd + "/percent_open"] !== undefined) {
            noohubSetDevIfChanged(vd + "/percent_open", noohubClampPercent(state.percent_open));
        }

        if (state.open_close !== undefined && dev[vd + "/open_close"] !== undefined) {
            noohubSetDevIfChanged(vd + "/open_close", !!state.open_close);
        }

        if (state.thermostat !== undefined && dev[vd + "/thermostat"] !== undefined) {
            noohubSetDevIfChanged(vd + "/thermostat", String(state.thermostat));
        }

        if (state.color !== undefined && dev[vd + "/color"] !== undefined) {
            if (typeof state.color === "object") {
                noohubSetDevIfChanged(vd + "/color", JSON.stringify(state.color));
            } else {
                noohubSetDevIfChanged(vd + "/color", String(state.color));
            }
        }

        if (dev[vd + "/last_update"] !== undefined) {
            dev[vd + "/last_update"] = noohubNowString();
        }

        if (dev[vd + "/status"] !== undefined) {
            noohubSetDevIfChanged(vd + "/status", "polled");
        }
    } catch (e) {
        noohubLog("poll state apply error for " + vd + ": " + e);
    } finally {
        noohubSetUpdatingFromPoll(false);
    }
}

function noohubPollOneDevice(index) {
    if (noohubPollCancelRequested) {
        noohubFinishPolling("poll stopped: command priority");
        return;
    }

    if (index >= noohubDevices.length) {
        noohubFinishPolling("poll complete");
        return;
    }

    var d = noohubDevices[index];

    if (!d || !d.id) {
        noohubPollOneDevice(index + 1);
        return;
    }

    if (d.retrievable !== true) {
        var vdSkip = "noohub_" + d.id;

        if (dev[vdSkip + "/status"] !== undefined) {
            noohubSetDevIfChanged(vdSkip + "/status", "skip poll: not retrievable");
        }

        noohubPollOneDevice(index + 1);
        return;
    }

    noohubApiRequest({
        action: "get_state",
        devices: [d.id]
    }, function(resp, raw) {
        if (noohubIsGoodStateResponse(resp)) {
            noohubApplyStateResponse(d.id, resp);
        } else {
            noohubLog("poll failed for " + d.id + ": " + noohubShortRawForStatus(raw));
        }

        if (noohubPollCancelRequested) {
            noohubFinishPolling("poll stopped: command priority");
            return;
        }

        noohubPollOneDevice(index + 1);
    }, true);
}

function noohubPollNow() {
    if (noohubPollingBusy) {
        var busyTimeoutMs = noohubDynamicPollingBusyTimeoutMs();

        if (noohubPollingBusyStartedAt &&
            new Date().getTime() - noohubPollingBusyStartedAt > busyTimeoutMs) {
            noohubPollingBusy = false;
            noohubPollingBusyStartedAt = 0;
            noohubPollCancelRequested = false;
            noohubPollBusySkipCount = 0;
            noohubSetUpdatingFromPoll(false);
            if (!noohubProtectPolling("poll watchdog reset")) {
                noohubSetStatus("poll busy reset by watchdog");
            }
        } else {
            noohubIsUpdatingFromPoll();
            noohubRecordPollBusySkip("poll is still running");
            noohubSetStatus("poll already running");
            return;
        }
    }

    if (noohubIsUpdatingFromPoll()) {
        noohubSetStatus("poll skipped: previous state update is still active");
        return;
    }

    var commandPauseMs = noohubCommandPauseRemainingMs();
    if (commandPauseMs > 0) {
        noohubSetStatus("poll skipped: command pause " + Math.ceil(commandPauseMs / 1000) + " sec");
        return;
    }

    if (noohubPollingBusy) {
        noohubSetStatus("poll already running");
        return;
    }

    if (!noohubDevices || noohubDevices.length === 0) {
        noohubSetStatus("poll skipped, no devices");
        return;
    }

    noohubPollingBusy = true;
    noohubPollingBusyStartedAt = new Date().getTime();
    noohubPollCancelRequested = false;
    noohubPollBusySkipCount = 0;
    noohubSetStatus("poll started");
    noohubPollOneDevice(0);
}

function noohubPollingTick() {
    if (!dev[NOOHUB_SETTINGS_DEVICE + "/polling_enabled"]) {
        return;
    }

    var interval = parseFloat(String(dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"]).replace(",", "."));
    interval = noohubNormalizePollInterval(interval);
    if (Math.abs(parseFloat(String(dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"]).replace(",", ".")) - interval) > 0.0001) {
        dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"] = interval;
    }

    var now = new Date().getTime();

    if (!noohubPollingTick.lastRun) {
        noohubPollingTick.lastRun = 0;
    }

    if (now - noohubPollingTick.lastRun >= interval * 1000) {
        noohubPollingTick.lastRun = now;
        noohubPollNow();
    }
}

setInterval(noohubPollingTick, NOOHUB_POLLING_TICK_MS);


// -----------------------------------------------------------------------------
// Delete all virtual devices
// -----------------------------------------------------------------------------

function noohubDeleteVirtualDevices() {
    noohubSetStatus("delete_virtual_devices started");

    dev[NOOHUB_SETTINGS_DEVICE + "/polling_enabled"] = false;
    noohubClearMemory();

    var unit = "noohub-delete-virtual-devices-" + new Date().getTime();

    var cmd =
        "systemd-run --unit=" + unit +
        " --collect " +
        noohubShellQuote(NOOHUB_DELETE_SCRIPT);

    noohubSetStatus("external delete script started");

    noohubRun(cmd, function(exitCode, output) {
        noohubLog("delete script systemd-run exit: " + exitCode);

        if (output) {
            noohubLog("delete script systemd-run output: " + output.substr(0, 300));
        }
    });
}


// -----------------------------------------------------------------------------
// Rules for settings device
// -----------------------------------------------------------------------------

defineRule("noohub_settings_ip_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/noohub_ip",
    then: function(newValue) {
        noohubIp = String(newValue || noohubIp);
        noohubUpdateApiUrlFromIp();
    }
});

defineRule("noohub_settings_id_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/noohub_id",
    then: function(newValue) {
        noohubId = String(newValue || noohubId);
    }
});

defineRule("noohub_settings_get_devices_type_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/get_devices_type",
    then: function(newValue) {
        noohubGetDevicesType = noohubNormalizeGetDevicesType(newValue);
        noohubSetStatus("get_devices type: " + noohubGetDevicesType);
    }
});

defineRule("noohub_settings_username_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/noohub_username",
    then: function(newValue) {
        noohubUsername = String(newValue || noohubUsername);
    }
});

defineRule("noohub_settings_auth_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/auth_enabled",
    then: function(newValue) {
        noohubAuthEnabled = !!newValue;
    }
});

defineRule("noohub_settings_polling_enabled_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/polling_enabled",
    then: function(newValue) {
        if (noohubSettingsLoading) {
            return;
        }

        noohubSaveSettings(true);
        noohubSetStatus("polling " + (newValue ? "enabled" : "disabled"));
    }
});

defineRule("noohub_settings_spruthub_mqtt_port_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/spruthub_mqtt_port",
    then: function(newValue) {
        noohubSprutHubMqttPort = noohubNormalizeSprutHubMqttPort(newValue);

        if (parseInt(newValue, 10) !== noohubSprutHubMqttPort) {
            dev[NOOHUB_SETTINGS_DEVICE + "/spruthub_mqtt_port"] = noohubSprutHubMqttPort;
        }

        noohubSetStatus("SprutHub MQTT port changed. Press Apply SprutHub MQTT Port.");
    }
});

defineRule("noohub_settings_apply_spruthub_mqtt_port", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/apply_spruthub_mqtt_port",
    then: function(newValue) {
        if (!noohubIsButtonPressed(newValue)) {
            return;
        }

        setTimeout(function() {
            dev[NOOHUB_SETTINGS_DEVICE + "/apply_spruthub_mqtt_port"] = false;
        }, 300);

        noohubApplySprutHubMqttPort();
    }
});

defineRule("noohub_settings_save", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/save_settings",
    then: function(newValue) {
        if (!noohubIsButtonPressed(newValue)) {
            return;
        }

        setTimeout(function() {
            dev[NOOHUB_SETTINGS_DEVICE + "/save_settings"] = false;
        }, 300);

        noohubSaveSettings();
    }
});

defineRule("noohub_settings_scan", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/scan_devices",
    then: function(newValue) {
        if (!noohubIsButtonPressed(newValue)) {
            return;
        }

        setTimeout(function() {
            dev[NOOHUB_SETTINGS_DEVICE + "/scan_devices"] = false;
        }, 300);

        noohubSetStatus("Apply Resync CH list requested");
        setTimeout(function() {
            noohubSyncOrResyncFromInput();
        }, 150);
    }
});

defineRule("noohub_settings_delete_virtual_devices", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/delete_virtual_devices",
    then: function(newValue) {
        if (!noohubIsButtonPressed(newValue)) {
            return;
        }

        dev[NOOHUB_SETTINGS_DEVICE + "/delete_virtual_devices"] = false;

        noohubSetStatus("Apply Delete CH list requested");
        setTimeout(function() {
            noohubDeleteChannelsFromInput();
        }, 150);
    }
});

defineRule("noohub_settings_poll_now", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/poll_now",
    then: function(newValue) {
        if (!noohubIsButtonPressed(newValue)) {
            return;
        }

        setTimeout(function() {
            dev[NOOHUB_SETTINGS_DEVICE + "/poll_now"] = false;
        }, 300);

        noohubPollNow();
    }
});

defineRule("noohub_settings_test_connection", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/test_connection",
    then: function(newValue) {
        if (!noohubIsButtonPressed(newValue)) {
            return;
        }

        setTimeout(function() {
            dev[NOOHUB_SETTINGS_DEVICE + "/test_connection"] = false;
        }, 300);

        noohubTestConnection();
    }
});

defineRule("noohub_settings_reset_runtime_locks", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/reset_runtime_locks",
    then: function(newValue) {
        if (!noohubIsButtonPressed(newValue)) {
            return;
        }

        setTimeout(function() {
            dev[NOOHUB_SETTINGS_DEVICE + "/reset_runtime_locks"] = false;
        }, 300);

        noohubResetRuntimeLocks("manual button");
    }
});

defineRule("noohub_settings_poll_interval_changed", {
    whenChanged: NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec",
    then: function(newValue) {
        if (noohubSettingsLoading) {
            return;
        }

        var interval = noohubNormalizePollInterval(newValue);

        if (Number(newValue) !== interval) {
            dev[NOOHUB_SETTINGS_DEVICE + "/poll_interval_sec"] = interval;
        }

        noohubSaveSettings(true);
        noohubSetStatus("poll interval: " + interval + " sec");
    }
});

for (var noohubInfoRuleIndex = 0; noohubInfoRuleIndex < NOOHUB_DEVICE_INFO_FIELDS.length; noohubInfoRuleIndex++) {
    (function(field) {
        defineRule("noohub_settings_" + noohubDeviceInfoSettingName(field.name) + "_changed", {
            whenChanged: NOOHUB_SETTINGS_DEVICE + "/" + noohubDeviceInfoSettingName(field.name),
            then: function(newValue) {
                if (noohubSettingsLoading) {
                    return;
                }

                noohubDeviceInfoVisible[field.name] = !!newValue;
                noohubSetStatus("device info visibility changed. Use Resync CH to recreate cards.");
            }
        });
    })(NOOHUB_DEVICE_INFO_FIELDS[noohubInfoRuleIndex]);
}


// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

noohubSetStatus("starting");

noohubLoadSettings(function(ok) {
    noohubSetPasswordStatus();

    noohubLoadDevicesFromFile(function(devicesOk) {
        if (devicesOk) {
            noohubSetStatus("started, devices restored");
            noohubResetNonRetrievableDevicesOnStartup();
        } else {
            noohubSetStatus("started, no saved devices");
        }
    });
});
