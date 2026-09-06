"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildDeviceFeatures, mapQuotaToState, readQuotaValue } = require("../src/device-river2");

function fakeGladys() {
  return {
    externalIds: (type, id) => ({
      device: `ext:${type}:${id}`,
      feature: (key) => `ext:${type}:${id}:${key}`,
    }),
  };
}

const EXPECTED_FEATURE_KEYS = [
  "battery_level",
  "charge_power",
  "discharge_power",
  "home_output_power",
  "remaining_minutes",
  "max_charge_level",
  "min_discharge_level",
  "backup_reserve_level",
  "ac_charging_power_limit",
  "solar_energy_total",
  "solar_savings_total",
  "ac_output",
  "car_output",
  "backup_reserve_enabled",
  "solar_input_power",
];

// ---------------------------------------------------------------------------
// buildDeviceFeatures
// ---------------------------------------------------------------------------

test("buildDeviceFeatures returns the device external id and every expected feature", () => {
  const result = buildDeviceFeatures(fakeGladys(), "SN123");

  assert.equal(result.device_external_id, "ext:battery-storage:SN123");
  assert.equal(result.features.length, EXPECTED_FEATURE_KEYS.length);

  const actualKeys = result.features.map((f) => f.external_id.split(":").pop());
  for (const key of EXPECTED_FEATURE_KEYS) {
    assert.ok(actualKeys.includes(key), `missing expected feature key: ${key}`);
  }
});

test("buildDeviceFeatures keeps switches read-only when control is disabled (default)", () => {
  const result = buildDeviceFeatures(fakeGladys(), "SN123");
  const switches = result.features.filter((f) =>
    ["ac_output", "car_output", "backup_reserve_enabled"].includes(f.external_id.split(":").pop()),
  );

  assert.equal(switches.length, 3);
  for (const sw of switches) {
    assert.equal(sw.read_only, true, `${sw.external_id} should be read-only when control is disabled`);
  }
});

test("buildDeviceFeatures makes switches writable when control is enabled", () => {
  const result = buildDeviceFeatures(fakeGladys(), "SN123", { controlEnabled: true });
  const switches = result.features.filter((f) =>
    ["ac_output", "car_output", "backup_reserve_enabled"].includes(f.external_id.split(":").pop()),
  );

  assert.equal(switches.length, 3);
  for (const sw of switches) {
    assert.equal(sw.read_only, false, `${sw.external_id} should be writable when control is enabled`);
  }
});

test("buildDeviceFeatures keeps every non-switch feature read-only regardless of controlEnabled", () => {
  const result = buildDeviceFeatures(fakeGladys(), "SN123", { controlEnabled: true });
  const nonSwitches = result.features.filter(
    (f) => !["ac_output", "car_output", "backup_reserve_enabled"].includes(f.external_id.split(":").pop()),
  );

  assert.ok(nonSwitches.length > 0);
  for (const f of nonSwitches) {
    assert.equal(f.read_only, true, `${f.external_id} should always stay read-only`);
  }
});

test("buildDeviceFeatures produces distinct, deterministic external_ids for two different serials", () => {
  const r1 = buildDeviceFeatures(fakeGladys(), "SN_A");
  const r2 = buildDeviceFeatures(fakeGladys(), "SN_B");

  assert.notEqual(r1.device_external_id, r2.device_external_id);
  assert.notEqual(r1.features[0].external_id, r2.features[0].external_id);

  // deterministic: building twice for the same serial gives identical ids
  const r1Again = buildDeviceFeatures(fakeGladys(), "SN_A");
  assert.equal(r1.device_external_id, r1Again.device_external_id);
  assert.equal(r1.features[0].external_id, r1Again.features[0].external_id);
});

// ---------------------------------------------------------------------------
// readQuotaValue
// ---------------------------------------------------------------------------

test("readQuotaValue reads a flat dotted key directly when present", () => {
  const quota = { "a.b.c": 42 };
  assert.equal(readQuotaValue(quota, "a.b.c"), 42);
});

test("readQuotaValue falls back to nested object traversal", () => {
  const quota = { a: { b: { c: 42 } } };
  assert.equal(readQuotaValue(quota, "a.b.c"), 42);
});

test("readQuotaValue returns undefined for a missing path without throwing", () => {
  assert.equal(readQuotaValue({}, "a.b.c"), undefined);
  assert.equal(readQuotaValue({ a: { b: {} } }, "a.b.c"), undefined);
  assert.equal(readQuotaValue({ a: null }, "a.b.c"), undefined);
  assert.equal(readQuotaValue({ a: 5 }, "a.b.c"), undefined); // a is not an object
});

// ---------------------------------------------------------------------------
// mapQuotaToState
// ---------------------------------------------------------------------------

test("mapQuotaToState returns an empty object for an empty quota, without throwing", () => {
  assert.deepEqual(mapQuotaToState({}), {});
});

test("mapQuotaToState ignores unknown fields silently", () => {
  const state = mapQuotaToState({ "some.unknown.field": 123, "another.one": "text" });
  assert.deepEqual(state, {});
});

test("mapQuotaToState reads battery_level with the correct fallback priority", () => {
  assert.equal(
    mapQuotaToState({ "bms_emsStatus.lcdShowSoc": 55, "pd.soc": 99 }).battery_level,
    55,
    "lcdShowSoc must win over pd.soc",
  );
  assert.equal(
    mapQuotaToState({ "pd.soc": 60, "bms_bmsStatus.soc": 99 }).battery_level,
    60,
    "pd.soc must win over bms_bmsStatus.soc when lcdShowSoc is absent",
  );
  assert.equal(
    mapQuotaToState({ "bms_bmsStatus.soc": 70, "bmsMaster.soc": 99 }).battery_level,
    70,
    "bms_bmsStatus.soc must win over the original bmsMaster.soc guess",
  );
  assert.equal(
    mapQuotaToState({ "bmsMaster.soc": 80 }).battery_level,
    80,
    "bmsMaster.soc is used as the last-resort fallback",
  );
});

test("mapQuotaToState clamps battery_level to 0-100", () => {
  assert.equal(mapQuotaToState({ "pd.soc": -5 }).battery_level, 0);
  assert.equal(mapQuotaToState({ "pd.soc": 150 }).battery_level, 100);
});

test("mapQuotaToState never reports a negative power reading", () => {
  assert.equal(mapQuotaToState({ "inv.inputWatts": -10 }).charge_power, 0);
  assert.equal(mapQuotaToState({ "inv.outputWatts": -10 }).discharge_power, 0);
  assert.equal(mapQuotaToState({ "mppt.inWatts": -10 }).solar_input_power, 0);
  assert.equal(mapQuotaToState({ "pd.wattsOutSum": -10 }).home_output_power, 0);
});

test("mapQuotaToState passes through positive power readings unchanged", () => {
  const state = mapQuotaToState({
    "inv.inputWatts": 120,
    "inv.outputWatts": 45,
    "mppt.inWatts": 200,
    "pd.wattsOutSum": 300,
  });
  assert.equal(state.charge_power, 120);
  assert.equal(state.discharge_power, 45);
  assert.equal(state.solar_input_power, 200);
  assert.equal(state.home_output_power, 300);
});

test("mapQuotaToState rounds remaining_minutes and rejects out-of-range values", () => {
  assert.equal(mapQuotaToState({ "pd.remainTime": 42.7 }).remaining_minutes, 43);
  assert.equal(mapQuotaToState({ "pd.remainTime": -1 }).remaining_minutes, undefined);
  assert.equal(mapQuotaToState({ "pd.remainTime": 100000 }).remaining_minutes, undefined);
  assert.equal(mapQuotaToState({ "pd.remainTime": 99999 }).remaining_minutes, 99999);
});

test("mapQuotaToState only accepts strict 0/1 for binary switch fields", () => {
  assert.equal(mapQuotaToState({ "inv.cfgAcEnabled": 1 }).ac_output, 1);
  assert.equal(mapQuotaToState({ "inv.cfgAcEnabled": 0 }).ac_output, 0);
  assert.equal(mapQuotaToState({ "inv.cfgAcEnabled": 2 }).ac_output, undefined);
  assert.equal(mapQuotaToState({ "inv.cfgAcEnabled": true }).ac_output, undefined);
  assert.equal(mapQuotaToState({ "inv.cfgAcEnabled": null }).ac_output, undefined);

  assert.equal(mapQuotaToState({ "pd.carState": 1 }).car_output, 1);
  assert.equal(mapQuotaToState({ "pd.carState": 5 }).car_output, undefined);

  assert.equal(mapQuotaToState({ "pd.watchIsConfig": 1 }).backup_reserve_enabled, 1);
  assert.equal(mapQuotaToState({ "pd.watchIsConfig": 5 }).backup_reserve_enabled, undefined);
});

test("mapQuotaToState clamps the four energy-management settings to their real bounds", () => {
  assert.equal(mapQuotaToState({ "bms_emsStatus.maxChargeSoc": 30 }).max_charge_level, 50, "clamped up to the 50 min");
  assert.equal(mapQuotaToState({ "bms_emsStatus.maxChargeSoc": 150 }).max_charge_level, 100);
  assert.equal(mapQuotaToState({ "bms_emsStatus.maxChargeSoc": 94 }).max_charge_level, 94);

  assert.equal(mapQuotaToState({ "bms_emsStatus.minDsgSoc": -5 }).min_discharge_level, 0);
  assert.equal(mapQuotaToState({ "bms_emsStatus.minDsgSoc": 50 }).min_discharge_level, 30);
  assert.equal(mapQuotaToState({ "bms_emsStatus.minDsgSoc": 20 }).min_discharge_level, 20);

  assert.equal(mapQuotaToState({ "pd.bpPowerSoc": 2 }).backup_reserve_level, 5);
  assert.equal(mapQuotaToState({ "pd.bpPowerSoc": 150 }).backup_reserve_level, 100);
  assert.equal(mapQuotaToState({ "pd.bpPowerSoc": 61 }).backup_reserve_level, 61);

  assert.equal(mapQuotaToState({ "mppt.cfgChgWatts": 50 }).ac_charging_power_limit, 100);
  assert.equal(mapQuotaToState({ "mppt.cfgChgWatts": 500 }).ac_charging_power_limit, 360);
  assert.equal(mapQuotaToState({ "mppt.cfgChgWatts": 250 }).ac_charging_power_limit, 250);
});

test("mapQuotaToState builds a complete, realistic state from a full real-shaped quota", () => {
  const quota = {
    "bms_emsStatus.lcdShowSoc": 57,
    "inv.inputWatts": 0,
    "mppt.inWatts": 180,
    "inv.outputWatts": 45,
    "pd.wattsOutSum": 45,
    "pd.remainTime": 389,
    "inv.cfgAcEnabled": 1,
    "pd.carState": 0,
    "pd.watchIsConfig": 1,
    "bms_emsStatus.maxChargeSoc": 94,
    "bms_emsStatus.minDsgSoc": 20,
    "pd.bpPowerSoc": 61,
    "mppt.cfgChgWatts": 250,
  };

  assert.deepEqual(mapQuotaToState(quota), {
    battery_level: 57,
    charge_power: 0,
    solar_input_power: 180,
    discharge_power: 45,
    home_output_power: 45,
    remaining_minutes: 389,
    ac_output: 1,
    car_output: 0,
    backup_reserve_enabled: 1,
    max_charge_level: 94,
    min_discharge_level: 20,
    backup_reserve_level: 61,
    ac_charging_power_limit: 250,
  });
});
