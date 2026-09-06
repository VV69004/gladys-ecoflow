"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexWithMocks } = require("./helpers/loadIndexWithMocks");

const BASE_APP_LOGIN_CONFIG = {
  connection_mode: "app_login",
  region: "eu",
  ecoflow_email: "test@example.com",
  ecoflow_password: "x",
  serial_number: "SN_TEST_0001",
};

function findFeature(published, suffix) {
  return published.find((p) => p.device_feature_external_id.endsWith(`:${suffix}`));
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

test("app-login mode reports disconnected when email/password are missing", async () => {
  const state = await loadIndexWithMocks({
    config: { connection_mode: "app_login", serial_number: "SN1" },
  });
  const last = state.connectionStatus[state.connectionStatus.length - 1];
  assert.equal(last.ok, false);
});

test("app-login mode reports disconnected when no serial number is configured", async () => {
  const state = await loadIndexWithMocks({
    config: { connection_mode: "app_login", ecoflow_email: "a@b.com", ecoflow_password: "x" },
  });
  const last = state.connectionStatus[state.connectionStatus.length - 1];
  assert.equal(last.ok, false);
});

test("app-login mode reports connected once a client successfully connects", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG });
  const last = state.connectionStatus[state.connectionStatus.length - 1];
  assert.equal(last.ok, true);
});

// ---------------------------------------------------------------------------
// Quota reception → publish, with debounce
// ---------------------------------------------------------------------------

test("a received quota is published to Gladys after the debounce window", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG });
  const mqtt = state.mqttInstances[0];

  mqtt._emitQuota("SN_TEST_0001", { "bms_emsStatus.lcdShowSoc": 57 });
  await new Promise((r) => setTimeout(r, 1700)); // > PUBLISH_DEBOUNCE_MS (1500ms)

  const battery = findFeature(state.published, "battery_level");
  assert.ok(battery, "battery_level should have been published");
  assert.equal(battery.state, 57);
});

test("a burst of rapid quota updates for the same serial results in a single publish call", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG });
  const mqtt = state.mqttInstances[0];

  const merged = {};
  for (let i = 0; i < 30; i++) {
    merged["bms_emsStatus.lcdShowSoc"] = 50 + i;
    mqtt._emitQuota("SN_TEST_0001", { ...merged });
  }
  await new Promise((r) => setTimeout(r, 1700));

  const batteryPublishes = state.published.filter((p) => p.device_feature_external_id.endsWith(":battery_level"));
  assert.equal(batteryPublishes.length, 1, "the burst must be coalesced into exactly one publish");
  assert.equal(batteryPublishes[0].state, 79, "the published value must be the LATEST one from the burst");
});

test("a quota for a serial with no created device is silently ignored", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG });
  const mqtt = state.mqttInstances[0];

  mqtt._emitQuota("SOME_OTHER_UNKNOWN_SERIAL", { "bms_emsStatus.lcdShowSoc": 42 });
  await new Promise((r) => setTimeout(r, 1700));

  assert.equal(state.published.length, 0);
});

// ---------------------------------------------------------------------------
// Control: onSetValue
// ---------------------------------------------------------------------------

test("onSetValue refuses any command when control is disabled (the default)", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG }); // enable_control not set
  const device = { params: [{ name: "SERIAL_NUMBER", value: "SN_TEST_0001" }] };

  await assert.rejects(
    () => state.onSetValueHandler(device, { external_id: "ext:x:x:ac_output" }, true),
    /Control is disabled/,
  );
});

test("onSetValue sends the real acOutCfg command for the AC output switch", async () => {
  let captured = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand(sn, moduleType, operateType, params) {
        captured = { sn, moduleType, operateType, params };
        return Promise.resolve();
      },
    },
  });

  const device = { params: [{ name: "SERIAL_NUMBER", value: "SN_TEST_0001" }] };
  await state.onSetValueHandler(device, { external_id: "ext:x:x:ac_output" }, true);

  assert.deepEqual(captured, {
    sn: "SN_TEST_0001",
    moduleType: 5,
    operateType: "acOutCfg",
    params: { enabled: 1, out_voltage: -1, out_freq: 255, xboost: 255 },
  });
});

test("onSetValue sends the real mpptCar command for the 12V output switch", async () => {
  let captured = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand(sn, moduleType, operateType, params) {
        captured = { sn, moduleType, operateType, params };
        return Promise.resolve();
      },
    },
  });

  const device = { params: [{ name: "SERIAL_NUMBER", value: "SN_TEST_0001" }] };
  await state.onSetValueHandler(device, { external_id: "ext:x:x:car_output" }, false);

  assert.equal(captured.moduleType, 5);
  assert.equal(captured.operateType, "mpptCar");
  assert.equal(captured.params.enabled, 0);
});

test("onSetValue sends the real watthConfig command for the backup reserve switch", async () => {
  let captured = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand(sn, moduleType, operateType, params) {
        captured = { sn, moduleType, operateType, params };
        return Promise.resolve();
      },
    },
  });

  const device = { params: [{ name: "SERIAL_NUMBER", value: "SN_TEST_0001" }] };
  await state.onSetValueHandler(device, { external_id: "ext:x:x:backup_reserve_enabled" }, true);

  assert.equal(captured.moduleType, 1);
  assert.equal(captured.operateType, "watthConfig");
  assert.deepEqual(captured.params, { isConfig: 1, bpPowerSoc: 50, minDsgSoc: 0, minChgSoc: 0 });
});

test("onSetValue does NOT publish an optimistic state — it requests the real quota instead", async () => {
  let requestedFor = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      requestLatestQuota(sn) {
        requestedFor = sn;
      },
    },
  });

  const device = { params: [{ name: "SERIAL_NUMBER", value: "SN_TEST_0001" }] };
  await state.onSetValueHandler(device, { external_id: "ext:x:x:ac_output" }, true);

  assert.equal(state.publishedStates.length, 0, "no optimistic publishState() call should happen");
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(requestedFor, "SN_TEST_0001", "a real requery must be triggered shortly after the command");
});

// ---------------------------------------------------------------------------
// Control: actions (set_max_charge_level, set_min_discharge_level, etc.)
// ---------------------------------------------------------------------------

test("set_max_charge_level rejects an out-of-bounds value without sending anything", async () => {
  let called = false;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand() {
        called = true;
        return Promise.resolve();
      },
    },
  });

  const result = await state.actions["set_max_charge_level"]({ percent: 40 }); // below the 50 min
  assert.equal(called, false);
  assert.match(result.en, /between 50 and 100/);
});

test("set_max_charge_level sends the real upsConfig command for a valid value", async () => {
  let captured = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand(sn, moduleType, operateType, params) {
        captured = { sn, moduleType, operateType, params };
        return Promise.resolve();
      },
    },
  });

  await state.actions["set_max_charge_level"]({ percent: 94 });
  assert.deepEqual(captured, { sn: "SN_TEST_0001", moduleType: 2, operateType: "upsConfig", params: { maxChgSoc: 94 } });
});

test("set_min_discharge_level sends the real dsgCfg command for a valid value", async () => {
  let captured = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand(sn, moduleType, operateType, params) {
        captured = { sn, moduleType, operateType, params };
        return Promise.resolve();
      },
    },
  });

  await state.actions["set_min_discharge_level"]({ percent: 20 });
  assert.deepEqual(captured, { sn: "SN_TEST_0001", moduleType: 2, operateType: "dsgCfg", params: { minDsgSoc: 20 } });
});

test("set_backup_reserve_level sends the real watthConfig command for a valid value", async () => {
  let captured = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand(sn, moduleType, operateType, params) {
        captured = { sn, moduleType, operateType, params };
        return Promise.resolve();
      },
    },
  });

  await state.actions["set_backup_reserve_level"]({ percent: 61 });
  assert.deepEqual(captured, {
    sn: "SN_TEST_0001",
    moduleType: 1,
    operateType: "watthConfig",
    params: { isConfig: 1, bpPowerSoc: 61, minDsgSoc: 0, minChgSoc: 0 },
  });
});

test("set_ac_charging_power sends the real acChgCfg command for a valid value", async () => {
  let captured = null;
  const state = await loadIndexWithMocks({
    config: { ...BASE_APP_LOGIN_CONFIG, enable_control: true },
    mqttClientOverrides: {
      sendSetCommand(sn, moduleType, operateType, params) {
        captured = { sn, moduleType, operateType, params };
        return Promise.resolve();
      },
    },
  });

  await state.actions["set_ac_charging_power"]({ watts: 250 });
  assert.deepEqual(captured, {
    sn: "SN_TEST_0001",
    moduleType: 5,
    operateType: "acChgCfg",
    params: { chgWatts: 250, chgPauseFlag: 255 },
  });
});

test("all four config actions refuse to run when control is disabled", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG }); // enable_control not set

  for (const [key, fields] of [
    ["set_max_charge_level", { percent: 94 }],
    ["set_min_discharge_level", { percent: 20 }],
    ["set_backup_reserve_level", { percent: 61 }],
    ["set_ac_charging_power", { watts: 250 }],
  ]) {
    const result = await state.actions[key](fields);
    assert.match(result.en, /disabled/i, `${key} should refuse when control is disabled`);
  }
});

// ---------------------------------------------------------------------------
// Solar energy aggregation
// ---------------------------------------------------------------------------

test("solar energy total starts from a previously persisted value on load", async () => {
  const state = await loadIndexWithMocks({
    config: {
      ...BASE_APP_LOGIN_CONFIG,
      price_per_kwh_tenthousandths: 2500, // €0.25/kWh
      "solar_energy_wh_SN_TEST_0001": 500, // 0.5 kWh persisted from a previous run
    },
  });
  const mqtt = state.mqttInstances[0];

  mqtt._emitQuota("SN_TEST_0001", { "mppt.inWatts": 100 });
  await new Promise((r) => setTimeout(r, 1700));

  const energy = findFeature(state.published, "solar_energy_total");
  assert.equal(energy.state, 0.5);
  const savings = findFeature(state.published, "solar_savings_total");
  assert.equal(savings.state, 0.13); // 0.5 kWh * 0.25€, rounded to 2 decimals
});

test("set_solar_energy_total restores a lost counter value and persists it immediately", async () => {
  // CONFIRMED live tonight: the counter is tied to a specific integration
  // installation, and deleting + reinstalling the integration loses it
  // entirely (Gladys' free config storage does not survive that). This
  // action is the manual recovery path.
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG });

  const result = await state.actions["set_solar_energy_total"]({ wh: 800 });
  assert.match(result.en, /0\.800 kWh/);
  assert.deepEqual(state.setConfigCalls[state.setConfigCalls.length - 1], {
    solar_energy_wh_SN_TEST_0001: 800,
  });

  const mqtt = state.mqttInstances[0];
  mqtt._emitQuota("SN_TEST_0001", { "mppt.inWatts": 100 });
  await new Promise((r) => setTimeout(r, 1700));

  const energy = findFeature(state.published, "solar_energy_total");
  assert.equal(energy.state, 0.8, "the next reading must build on the restored value, not reset to 0");
});

test("set_solar_energy_total rejects a negative value", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG });
  const result = await state.actions["set_solar_energy_total"]({ wh: -5 });
  assert.match(result.en, /non-negative/);
  assert.equal(state.setConfigCalls.length, 0);
});

test("price_per_kwh_tenthousandths preserves 4 decimal places through the real conversion code", async () => {
  // CONFIRMED against the user's real electricity bill: French peak/off-peak
  // rates need 4 decimals (€0.2142/kWh peak, €0.1589/kWh off-peak) — even
  // thousandths (3 decimals) would still round this away, hence
  // ten-thousandths.
  const state = await loadIndexWithMocks({
    config: {
      ...BASE_APP_LOGIN_CONFIG,
      price_per_kwh_tenthousandths: 2142, // €0.2142/kWh, a real French peak-hour rate
      "solar_energy_wh_SN_TEST_0001": 2000, // 2 kWh persisted
    },
  });
  const mqtt = state.mqttInstances[0];

  mqtt._emitQuota("SN_TEST_0001", { "mppt.inWatts": 100 });
  await new Promise((r) => setTimeout(r, 1700));

  const savings = findFeature(state.published, "solar_savings_total");
  assert.equal(savings.state, 0.43); // 2 kWh * 0.2142€ = 0.4284€, rounded to 2 decimals for display
});

test("solar energy accumulates over time based on power × elapsed duration", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG });
  const mqtt = state.mqttInstances[0];

  mqtt._emitQuota("SN_TEST_0001", { "mppt.inWatts": 2000 });
  await new Promise((r) => setTimeout(r, 1700));

  await new Promise((r) => setTimeout(r, 4000));
  mqtt._emitQuota("SN_TEST_0001", { "mppt.inWatts": 2000 });
  await new Promise((r) => setTimeout(r, 1700));

  const energies = state.published
    .filter((p) => p.device_feature_external_id.endsWith(":solar_energy_total"))
    .map((p) => p.state);

  assert.equal(energies.length, 2);
  assert.ok(energies[1] > energies[0], "the second reading must be higher than the first");
});

test("solar_savings_total is omitted entirely when no price is configured", async () => {
  const state = await loadIndexWithMocks({ config: BASE_APP_LOGIN_CONFIG }); // no price_per_kwh_tenthousandths
  const mqtt = state.mqttInstances[0];

  mqtt._emitQuota("SN_TEST_0001", { "mppt.inWatts": 100 });
  await new Promise((r) => setTimeout(r, 1700));

  const savings = findFeature(state.published, "solar_savings_total");
  assert.equal(savings, undefined);
});
