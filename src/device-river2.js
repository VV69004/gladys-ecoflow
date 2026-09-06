"use strict";

const { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES, DEVICE_FEATURE_UNITS } = require("@gladysassistant/integration-sdk");

/**
 * Quota keys requested on every poll for a RIVER 2 family device (R621 / R631 / R622)
 * via the official Public API (POST /iot-open/sign/device/quota).
 *
 * These field names follow EcoFlow's flat "bmsMaster.*" / "inv.*" / "pd.*" quota
 * convention used across the RIVER 2 / DELTA 2 generation. EcoFlow does not publish
 * an exhaustive per-model field dictionary for the public API, so this list covers
 * the fields consistently reported across community projects for this device
 * family. Unknown/renamed fields are simply skipped (see mapQuotaToState below) -
 * they never throw, so a firmware difference degrades gracefully instead of
 * breaking the integration.
 */
const MONITOR_QUOTA_KEYS = [
  // CONFIRMED against a real River 2 (2026-09-02, live capture): the actual
  // field matching the device's own LCD display is "bms_emsStatus.lcdShowSoc"
  // — "bmsMaster.soc" (kept as a fallback below) doesn't exist on this
  // firmware, it was a guess based on the general RIVER2/DELTA2 convention.
  "bms_emsStatus.lcdShowSoc", // battery state of charge, 0-100 (%) — matches the device's own LCD
  "pd.soc", // same value, alternate field name, kept as a fallback
  "bmsMaster.soc", // original guess, kept in case another firmware/model does use it
  "bmsMaster.temp", // battery temperature, °C
  "bmsMaster.designCap", // design capacity, mAh
  "bmsMaster.fullCap", // full charge capacity, mAh
  "inv.inputWatts", // instantaneous power charging the unit (AC/solar/car), W
  "mppt.inWatts", // solar panel input power specifically, W — confirmed present on a real River 2
  "inv.outputWatts", // instantaneous power delivered to AC/DC/USB outputs, W
  "pd.wattsInSum", // total input watts (all sources)
  "pd.wattsOutSum", // total output watts (all outputs)
  "pd.remainTime", // remaining runtime at current load, minutes (charge or discharge)
  "pd.carState", // 12V car output on/off
  "pd.watchIsConfig", // backup reserve enabled on/off
  "pd.dcOutState", // DC (5521/USB-C PD) output on/off
  "inv.cfgAcEnabled", // AC inverter output on/off
  "bms_emsStatus.maxChargeSoc", // configured max charge level, % — "Limite de charge" in the official app
  "bms_emsStatus.minDsgSoc", // configured min discharge level, % — "Limite de décharge" in the official app
  "pd.bpPowerSoc", // configured backup reserve level, % — the app's Backup Reserve slider
  "mppt.cfgChgWatts", // configured AC charging power limit, W
];

function buildDeviceFeatures(gladys, sn, options = {}) {
  const ids = gladys.externalIds("battery-storage", sn);
  const batteryLevelFeature = {
    name: "Niveau de batterie",
    external_id: ids.feature("battery_level"),
    category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
    type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };

  const features = [
    batteryLevelFeature,
    {
      name: "Puissance de charge",
      external_id: ids.feature("charge_power"),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: 1000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: "Puissance de décharge",
      external_id: ids.feature("discharge_power"),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.DISCHARGE_POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: 1000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: "Sortie vers la maison",
      external_id: ids.feature("home_output_power"),
      category: DEVICE_FEATURE_CATEGORIES.HOME_OUTPUT_SENSOR,
      type: DEVICE_FEATURE_TYPES.HOME_OUTPUT_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: 1000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: "Autonomie restante",
      external_id: ids.feature("remaining_minutes"),
      category: DEVICE_FEATURE_CATEGORIES.DURATION,
      type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
      unit: DEVICE_FEATURE_UNITS.MINUTES,
      min: 0,
      max: 100000,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      // So the corresponding actions (set_max_charge_level etc.) can be
      // used with a known starting point instead of guessing — CONFIRMED
      // tonight: actions have no way to show a current value themselves,
      // this is the fix, surfacing the same 4 settings as real, visible
      // dashboard features (read-only; changed via the actions).
      name: "Limite de charge max",
      external_id: ids.feature("max_charge_level"),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 50,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      name: "Limite de décharge min",
      external_id: ids.feature("min_discharge_level"),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 30,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      name: "Niveau de réserve de secours",
      external_id: ids.feature("backup_reserve_level"),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 5,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      name: "Limite de puissance de charge AC",
      external_id: ids.feature("ac_charging_power_limit"),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 100,
      max: 360,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      // A rough estimate on purpose, not a precise energy audit — simple
      // rectangular integration of the instantaneous solar_input_power
      // reading over elapsed time between two MQTT updates, persisted
      // across restarts via gladys.setConfig() (see index.js). Good
      // enough to answer "roughly how much am I saving with solar",
      // explicitly not meant to match a real production meter.
      name: "Énergie solaire cumulée",
      external_id: ids.feature("solar_energy_total"),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 1000000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: "Économies solaires estimées",
      external_id: ids.feature("solar_savings_total"),
      category: DEVICE_FEATURE_CATEGORIES.CURRENCY,
      type: DEVICE_FEATURE_TYPES.CURRENCY.DECIMAL,
      unit: DEVICE_FEATURE_UNITS.EURO,
      min: 0,
      max: 1000000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: "Sortie CA (AC)",
      external_id: ids.feature("ac_output"),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      // Read-only unless the user has provided an AC command code in the
      // integration configuration (advanced/experimental, see docs).
      read_only: !options.controlEnabled,
      has_feedback: true,
      keep_history: false,
    },
    {
      name: "Sortie 12V (voiture)",
      external_id: ids.feature("car_output"),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: !options.controlEnabled,
      has_feedback: true,
      keep_history: false,
    },
    {
      name: "Réserve de secours activée",
      external_id: ids.feature("backup_reserve_enabled"),
      // "pd.watchIsConfig" in EcoFlow's own app-login quota — matches the
      // "Réserve de secours" toggle in the official app's Energy
      // Management screen. Command: {moduleType:1, operateType:"watthConfig",
      // params:{isConfig, bpPowerSoc, minDsgSoc:0, minChgSoc:0}} — sourced
      // from tolwi/hassio-ecoflow-cloud's River2 device definition,
      // UNTESTED against a real device.
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      min: 0,
      max: 1,
      read_only: !options.controlEnabled,
      has_feedback: true,
      keep_history: false,
    },
    {
      name: "Puissance solaire",
      external_id: ids.feature("solar_input_power"),
      // CONFIRMED against a real River 2 payload (2026-09-02): "mppt.inWatts"
      // is present and correctly tracks solar panel input power. This
      // feature was simply missing until now, not a wrong-field-name bug.
      // BATTERY_STORAGE.CHARGE_POWER (same type as the aggregate "charge_power"
      // above) fits better than HOME_OUTPUT_SENSOR: solar is an INPUT
      // (charging) source, not power going OUT to the house.
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER,
      unit: DEVICE_FEATURE_UNITS.WATT,
      min: 0,
      max: 1000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];

  return { device_external_id: ids.device, features, ids };
}

/**
 * Reads a dotted-path key out of the (already flat) quota object, tolerating
 * both the flat "a.b.c" key form the API returns and a nested object shape.
 */
function readQuotaValue(quota, dottedKey) {
  if (Object.prototype.hasOwnProperty.call(quota, dottedKey)) {
    return quota[dottedKey];
  }
  const parts = dottedKey.split(".");
  let cursor = quota;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object" || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * Maps a raw quota payload to { featureKey: value } for the features declared
 * above. Missing/renamed fields are simply omitted rather than throwing, so a
 * firmware or regional API difference degrades gracefully.
 */
function mapQuotaToState(quota) {
  const out = {};

  // CONFIRMED against a real River 2 payload (2026-09-02, 175 fields
  // captured live via app-login MQTT): "bmsMaster.soc" does NOT exist on
  // this device/firmware — it was a guess based on the general RIVER2/
  // DELTA2 family convention, wrong for this exact quota schema. The real
  // field, matching what the device's own LCD/the mobile app displays, is
  // "bms_emsStatus.lcdShowSoc". "pd.soc" and "bms_bmsStatus.soc" are also
  // present and equal, kept as fallbacks; the original guess is kept last
  // in case some OTHER firmware/model really does use it.
  const soc = readQuotaValue(quota, "bms_emsStatus.lcdShowSoc") ??
    readQuotaValue(quota, "pd.soc") ??
    readQuotaValue(quota, "bms_bmsStatus.soc") ??
    readQuotaValue(quota, "bmsMaster.soc");
  if (typeof soc === "number") out.battery_level = clamp(soc, 0, 100);

  const inWatts = readQuotaValue(quota, "inv.inputWatts");
  if (typeof inWatts === "number") out.charge_power = Math.max(0, inWatts);

  const solarWatts = readQuotaValue(quota, "mppt.inWatts");
  if (typeof solarWatts === "number") out.solar_input_power = Math.max(0, solarWatts);

  const outWatts = readQuotaValue(quota, "inv.outputWatts");
  if (typeof outWatts === "number") out.discharge_power = Math.max(0, outWatts);

  const homeOut = readQuotaValue(quota, "pd.wattsOutSum");
  if (typeof homeOut === "number") out.home_output_power = Math.max(0, homeOut);

  const remain = readQuotaValue(quota, "pd.remainTime");
  if (typeof remain === "number" && remain >= 0 && remain < 100000) out.remaining_minutes = Math.round(remain);

  const acEnabled = readQuotaValue(quota, "inv.cfgAcEnabled");
  if (acEnabled === 0 || acEnabled === 1) out.ac_output = acEnabled;

  const carState = readQuotaValue(quota, "pd.carState");
  if (carState === 0 || carState === 1) out.car_output = carState;

  const backupReserveEnabled = readQuotaValue(quota, "pd.watchIsConfig");
  if (backupReserveEnabled === 0 || backupReserveEnabled === 1) out.backup_reserve_enabled = backupReserveEnabled;

  const maxChargeLevel = readQuotaValue(quota, "bms_emsStatus.maxChargeSoc");
  if (typeof maxChargeLevel === "number") out.max_charge_level = clamp(maxChargeLevel, 50, 100);

  const minDischargeLevel = readQuotaValue(quota, "bms_emsStatus.minDsgSoc");
  if (typeof minDischargeLevel === "number") out.min_discharge_level = clamp(minDischargeLevel, 0, 30);

  const backupReserveLevel = readQuotaValue(quota, "pd.bpPowerSoc");
  if (typeof backupReserveLevel === "number") out.backup_reserve_level = clamp(backupReserveLevel, 5, 100);

  const acChargingPowerLimit = readQuotaValue(quota, "mppt.cfgChgWatts");
  if (typeof acChargingPowerLimit === "number") out.ac_charging_power_limit = clamp(acChargingPowerLimit, 100, 360);

  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  MONITOR_QUOTA_KEYS,
  buildDeviceFeatures,
  mapQuotaToState,
  readQuotaValue,
};
