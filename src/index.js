"use strict";

const { GladysIntegration, logger } = require("@gladysassistant/integration-sdk");
const { EcoflowClient } = require("./ecoflow-client");
const { EcoflowAppMqttClient } = require("./ecoflow-app-mqtt-client");
const { MONITOR_QUOTA_KEYS, buildDeviceFeatures, mapQuotaToState } = require("./device-river2");

const gladys = new GladysIntegration();

const POLL_INTERVAL_MS = 30 * 1000; // Developer API rate limits are generous, but no need to hammer it.

let restClient = null; // official Developer REST API — for officially-supported models
let mqttClient = null; // unofficial app-login MQTT — for models absent from the Developer API catalog (e.g. base River 2)
let connectionMode = "developer_api"; // "developer_api" | "app_login"
let pollTimer = null;
let knownSerials = []; // populated by scan / config
let controlEnabled = false; // becomes true only if the user filled in the AC command code
let acCommandCode = null;
let carCommandCode = null;
let deviceIdsBySerial = new Map(); // sn -> { device_external_id, features, ids }
let lastAppliedConfigFingerprint = null; // guards against needless MQTT session churn — see reconfigure()
const publishDebounce = new Map(); // sn -> { timer, latestQuota } — see publishStateFromQuota()
const PUBLISH_DEBOUNCE_MS = 1500; // Gladys rate-limits at 300 states/minute; a burst of catch-up
// MQTT messages after a reconnect can otherwise fire dozens of publishStates()
// calls within milliseconds and trip a 429 — CONFIRMED live tonight
// (2026-09-05). This coalesces rapid-fire updates into one publish using
// whatever is the LATEST accumulated quota once things settle, rather than
// skipping data or comparing against a persistent cache (that was a
// different, already-fixed bug — see the note below on why this isn't the
// same "only publish if changed" mistake as before).

let pricePerKwh = null; // null = savings feature disabled, only the raw kWh total is still tracked

// Rough, intentionally-not-precise solar energy aggregation — see
// device-river2.js's solar_energy_total feature comment for why a simple
// rectangular integration is good enough here. One entry per known
// serial: { totalWh, lastSampleAtMs }. Persisted across restarts via
// gladys.setConfig()'s free internal storage (see loadSolarAggregate /
// persistSolarAggregate below) — NOT declared in the manifest
// config_schema, so it never shows up as a user-editable field.
const solarAggregateBySerial = new Map();
let lastSolarPersistAtMs = 0;
const SOLAR_PERSIST_INTERVAL_MS = 15000; // CONFIRMED live (2026-09-09): 60s was too
// coarse — every container stop (not just full reinstalls) could lose up to a
// minute of the solar energy counter if the graceful shutdown save (below)
// didn't complete in time. 15s keeps the regular save recent enough that even
// a hard/ungraceful stop only loses a few seconds, while staying well under
// any reasonable API rate limit (this is one config write per ~15s at most,
// nothing like the burst that caused the earlier 429 issue).
const SOLAR_MAX_GAP_MS = 5 * 60 * 1000; // a gap longer than this (restart, outage) is skipped rather
// than integrated at the last-known wattage, which would wildly
// overstate energy production across a multi-hour or multi-day gap.

function buildRestClientFromConfig(config) {
  if (!config || !config.access_key || !config.secret_key) {
    return null;
  }
  return new EcoflowClient({
    accessKey: config.access_key,
    secretKey: config.secret_key,
    region: config.region === "us" ? "us" : "eu",
  });
}

// Only the fields that actually affect which client(s) we build / how they
// connect — deliberately excludes anything that shouldn't force a
// reconnect (there is nothing else in this config right now, but this
// keeps the intent explicit if fields are added later).
function configFingerprint(config) {
  if (!config) return "null";
  return JSON.stringify({
    connection_mode: config.connection_mode,
    region: config.region,
    access_key: config.access_key,
    secret_key: config.secret_key,
    ecoflow_email: config.ecoflow_email,
    ecoflow_password: config.ecoflow_password,
    serial_number: config.serial_number,
    enable_control: config.enable_control,
    ac_command_code: config.ac_command_code,
    car_command_code: config.car_command_code,
  });
}

async function reconfigure() {
  const config = await gladys.getConfig();

  // OBSERVED tonight (2026-09-02, not fully proven — this is server-side
  // Gladys core behavior we can't inspect from this integration's own
  // code): right after "connection to Gladys lost... retrying" /
  // reconnected in the logs, our onConfigUpdated handler fired again with
  // an UNCHANGED config, rebuilding the whole EcoFlow MQTT session and
  // resetting the accumulated quota + the wait-for-first-message clock
  // before telemetry (which can take several minutes to start trickling
  // in) ever had a chance to arrive. Whatever the exact trigger, skipping
  // a rebuild when nothing relevant actually changed is a safe, sensible
  // guard regardless — added specifically because this, not the earlier
  // QoS theory (which was tested and ruled out), looks like the real
  // cause of "always empty after the first successful capture".
  const fingerprint = configFingerprint(config);
  if (fingerprint === lastAppliedConfigFingerprint && (restClient || mqttClient)) {
    logger.info("EcoFlow: reconfigure() called but config is unchanged — keeping the existing connection.");
    return;
  }
  lastAppliedConfigFingerprint = fingerprint;

  connectionMode =
    config && config.connection_mode === "app_login" ? "app_login" : "developer_api";
  // App-login mode uses fixed, built-in commands (see onSetValue below) —
  // no per-model cmdCode needed. Developer API mode still needs one, since
  // EcoFlow doesn't publish a per-model command reference for that API.
  controlEnabled = Boolean(
    config &&
      config.enable_control &&
      (config.connection_mode === "app_login" || config.ac_command_code),
  );
  acCommandCode = config && config.ac_command_code ? config.ac_command_code : null;
  carCommandCode = config && config.car_command_code ? config.car_command_code : null;

  if (config && config.serial_number) {
    knownSerials = [config.serial_number.trim()].filter(Boolean);
  }

  // Stored in whole ten-thousandths of a currency unit
  // (config.price_per_kwh_tenthousandths) because Gladys' "number" config
  // field type only accepts integers — CONFIRMED against the real,
  // canonical manifest.schema.json (only min/max are supported for
  // "number", no step/decimal property exists at all). Real French
  // electricity tariffs need 4 decimal places (e.g. €0.2142/kWh peak,
  // €0.1589/kWh off-peak — CONFIRMED against the user's actual bill), so
  // thousandths (3 decimals) was still not fine-grained enough.
  const parsedPriceTenThousandths = config ? Number(config.price_per_kwh_tenthousandths) : NaN;
  const parsedPrice = Number.isFinite(parsedPriceTenThousandths) ? parsedPriceTenThousandths / 10000 : NaN;
  pricePerKwh = Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : null;

  // Load each known serial's previously-persisted solar energy total from
  // Gladys' free internal config storage (see the top-of-file comment on
  // solarAggregateBySerial) — a key outside the manifest's config_schema,
  // so it's invisible in the UI but survives container restarts, unlike a
  // plain in-memory variable would.
  //
  // CONFIRMED live (2026-09-12): the real Gladys API validates config keys
  // against /[a-z0-9_]/ (lowercase only) and rejects anything else with a
  // GladysApiError — this failed SILENTLY on every single write for hours
  // because the serial number (e.g. "R601ZEB4HE9T2333") is uppercase, and
  // the failure was never logged until diagnostic logging was added. Hence
  // .toLowerCase() here and on the write side below — the EcoFlow API
  // itself still gets the real, unmodified serial everywhere else.
  for (const sn of knownSerials) {
    if (solarAggregateBySerial.has(sn)) continue; // already loaded this run
    const persistedWh = config ? Number(config[`solar_energy_wh_${sn.toLowerCase()}`]) : NaN;
    solarAggregateBySerial.set(sn, {
      totalWh: Number.isFinite(persistedWh) && persistedWh >= 0 ? persistedWh : 0,
      lastSampleAtMs: null, // intentionally not persisted — see SOLAR_MAX_GAP_MS above
    });
  }

  // CONFIRMED BUG (2026-09-03, live): deviceIdsBySerial was previously only
  // populated inside onScanRequest — an in-memory Map that resets on every
  // container restart. Real symptom observed tonight: the debug action
  // showed a full, correct accumulated quota arriving over MQTT, yet
  // nothing ever reached Gladys — publishStateFromQuota() was silently
  // no-op-ing every single time because deviceIdsBySerial.get(sn) was
  // empty after the most recent restart, and nothing re-populated it
  // without an explicit manual re-scan. Fixed: (re)build it here for every
  // known serial on every (re)configure, unconditionally — a device's
  // external_id/features are fully deterministic from its serial number
  // alone (see buildDeviceFeatures), so there's no real need to wait for
  // an explicit scan just to compute this locally.
  for (const sn of knownSerials) {
    deviceIdsBySerial.set(sn, buildDeviceFeatures(gladys, sn, { controlEnabled }));
  }

  // Tear down whichever client was previously active before (re)building —
  // onConfigUpdated can flip connection_mode or re-enter credentials at any time.
  if (mqttClient) {
    mqttClient.disconnect();
    mqttClient = null;
  }
  restClient = null;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (connectionMode === "app_login") {
    await startAppLoginMode(config);
  } else {
    restClient = buildRestClientFromConfig(config);
    gladys.setConnectionStatus(
      Boolean(restClient),
      restClient
        ? undefined
        : {
            en: "Missing Access Key / Secret Key: fill in the configuration screen.",
            fr: "Access Key / Secret Key manquants : renseignez-les dans l'écran de configuration.",
          },
    );
    restartPolling();
  }
}

async function startAppLoginMode(config) {
  if (!config || !config.ecoflow_email || !config.ecoflow_password) {
    gladys.setConnectionStatus(false, {
      en: "App-login mode: email/password missing — fill in the configuration screen.",
      fr: "Mode connexion appli : email/mot de passe manquant — renseignez-les dans l'écran de configuration.",
    });
    return;
  }
  if (knownSerials.length === 0) {
    gladys.setConnectionStatus(false, {
      en: "App-login mode: no serial number configured — enter your device's serial number.",
      fr: "Mode connexion appli : aucun numéro de série configuré — renseignez celui de votre appareil.",
    });
    return;
  }

  mqttClient = new EcoflowAppMqttClient({
    email: config.ecoflow_email,
    password: config.ecoflow_password,
    region: config.region === "us" ? "us" : "eu",
  });
  mqttClient.onQuotaUpdate((sn, quota) => {
    publishStateFromQuota(sn, quota).catch((err) => logger.error("EcoFlow MQTT publish failed", err));
  });

  try {
    await mqttClient.connect(knownSerials);
    gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error("EcoFlow app-login MQTT connection failed", err);
    gladys.setConnectionStatus(false, {
      en: `EcoFlow MQTT login failed: ${err.message}`,
      fr: `Échec de connexion MQTT EcoFlow : ${err.message}`,
    });
  }
}

async function publishStateFromQuota(sn, quota) {
  const cached = deviceIdsBySerial.get(sn);
  if (!cached) return; // device not created by the user yet, nothing to publish to

  // Debounce: record the latest quota for this serial, and only actually
  // call the Gladys API once no new message has arrived for
  // PUBLISH_DEBOUNCE_MS. This is NOT a return to the old "only publish if
  // the value changed" bug (that compared against a cache that could go
  // stale across restarts) — it never skips a value, it just avoids
  // calling the API dozens of times per second when many MQTT messages
  // land in a tight burst (e.g. right after a reconnect), which is exactly
  // what tripped Gladys' own rate limit (429 Too Many Requests) tonight.
  const existing = publishDebounce.get(sn);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    publishDebounce.delete(sn);
    doPublish(sn, cached, quota).catch((err) => logger.error("EcoFlow MQTT publish failed", err));
  }, PUBLISH_DEBOUNCE_MS);

  publishDebounce.set(sn, { timer });
}

async function doPublish(sn, cached, quota) {
  // CONFIRMED BUG (2026-09-03, live): the previous "only publish if changed
  // from lastValues" optimization compared against an IN-MEMORY cache that
  // resets to empty on every container restart — while Gladys itself keeps
  // whatever value it was told BEFORE the restart. These two "memories" can
  // silently diverge (e.g. this integration's own cache thinks a value is
  // still unset/different, while Gladys already shows something else from
  // before), and there is no reliable way to safely resync the cache to
  // Gladys' actual current state without re-reading it back. Simpler and
  // fully robust: always publish the complete current state on every
  // update, with no attempt at diffing — Gladys is guaranteed to match
  // exactly what was last received over MQTT, regardless of restarts.
  const state = mapQuotaToState(quota);

  if (typeof state.solar_input_power === "number") {
    updateSolarEnergyAggregate(sn, state.solar_input_power, state);
  }

  const updates = Object.entries(state).map(([key, value]) => ({
    device_feature_external_id: cached.ids.feature(key),
    state: value,
  }));

  if (updates.length > 0) {
    await gladys.publishStates(updates);
    // Visible in the regular Logs tab WITHOUT needing to click the debug
    // action each time — a compact one-line summary of what was sent to
    // Gladys this cycle.
    const summary = Object.entries(state)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    logger.info(`EcoFlow (${sn}): published to Gladys — ${summary}`);
  }

  maybePersistSolarAggregate().catch((err) =>
    logger.warn("EcoFlow: unexpected error in maybePersistSolarAggregate", err),
  );
}

/**
 * Rough, intentionally-not-precise cumulative solar energy tracker — a
 * simple rectangular integration (power × elapsed time) between this
 * sample and the previous one for the same serial. Mutates `state` in
 * place to add solar_energy_total (kWh) and, if a price is configured,
 * solar_savings_total (currency) so both ride along in the same publish
 * batch as everything else this cycle — no separate API call needed.
 */
function updateSolarEnergyAggregate(sn, solarWatts, state) {
  const now = Date.now();
  const agg = solarAggregateBySerial.get(sn) || { totalWh: 0, lastSampleAtMs: null };

  if (agg.lastSampleAtMs !== null) {
    const elapsedMs = now - agg.lastSampleAtMs;
    if (elapsedMs > 0 && elapsedMs <= SOLAR_MAX_GAP_MS) {
      agg.totalWh += solarWatts * (elapsedMs / 3600000);
    }
    // else: gap too long (restart, outage) or clock went backwards —
    // skip integrating this interval rather than risk wildly overstating
    // production, per SOLAR_MAX_GAP_MS's own comment above.
  }
  agg.lastSampleAtMs = now;
  solarAggregateBySerial.set(sn, agg);

  const totalKwh = agg.totalWh / 1000;
  state.solar_energy_total = Math.round(totalKwh * 1000) / 1000; // 3 decimal places is plenty for a rough estimate
  if (pricePerKwh !== null) {
    state.solar_savings_total = Math.round(totalKwh * pricePerKwh * 100) / 100;
  }
}

/**
 * Persists each known serial's running solar energy total to Gladys' free
 * internal config storage (see the top-of-file comment), throttled to at
 * most once every SOLAR_PERSIST_INTERVAL_MS — not on every single sample,
 * to avoid hammering the config API the same way the states API was
 * hammered before the publish-debounce fix earlier tonight.
 */
async function maybePersistSolarAggregate() {
  const now = Date.now();
  if (now - lastSolarPersistAtMs < SOLAR_PERSIST_INTERVAL_MS) return;
  lastSolarPersistAtMs = now;

  const toPersist = {};
  for (const [sn, agg] of solarAggregateBySerial.entries()) {
    toPersist[`solar_energy_wh_${sn.toLowerCase()}`] = agg.totalWh;
  }
  if (Object.keys(toPersist).length === 0) return;

  try {
    // CONFIRMED live (2026-09-11): the counter kept resetting to 0 on every
    // stop despite hours of runtime and a working periodic save path — this
    // logging never existed before, so there was literally no way to see
    // whether setConfig() ever actually succeeded. Checking `result.success`
    // explicitly (not just "did it throw") because the SDK's own doc shows
    // this call can resolve normally with `{ success: false }`.
    const result = await gladys.setConfig(toPersist);
    if (result && result.success) {
      logger.info(`EcoFlow: solar energy total persisted — ${JSON.stringify(toPersist)}`);
    } else {
      logger.warn(`EcoFlow: setConfig() resolved without success for solar energy total — ${JSON.stringify(result)}`);
    }
  } catch (err) {
    logger.warn("EcoFlow: failed to persist the solar energy total (will retry next cycle)", err);
  }
}

function restartPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (connectionMode !== "developer_api") return; // app-login mode is event-driven (MQTT push), no polling
  if (restClient && knownSerials.length > 0) {
    pollTimer = setInterval(() => {
      pollAllDevices().catch((err) => logger.error("EcoFlow poll failed", err));
    }, POLL_INTERVAL_MS);
    // Poll once immediately instead of waiting for the first interval.
    pollAllDevices().catch((err) => logger.error("EcoFlow initial poll failed", err));
  }
}

async function pollAllDevices() {
  if (!restClient) return;

  for (const sn of knownSerials) {
    try {
      const quota = await restClient.getQuota(sn, MONITOR_QUOTA_KEYS);
      await publishStateFromQuota(sn, quota);
      gladys.setConnectionStatus(true);
    } catch (err) {
      logger.error(`EcoFlow: failed to poll device ${sn}`, err);
      gladys.setConnectionStatus(false, {
        en: `EcoFlow API error for ${sn}: ${err.message}`,
        fr: `Erreur de l'API EcoFlow pour ${sn} : ${err.message}`,
      });
    }
  }
}

gladys.onScanRequest(async () => {
  if (connectionMode === "app_login") {
    // No device-list API in this unofficial mode — the user enters the
    // serial number by hand in the config screen (existing field, required
    // in this mode even though it's marked optional for developer_api mode).
    if (knownSerials.length === 0) {
      logger.warn("EcoFlow (app-login mode): scan requested but no serial number configured yet.");
      await gladys.publishDiscoveredDevices([]);
      return;
    }
    const discovered = knownSerials.map((sn) => {
      const built = buildDeviceFeatures(gladys, sn, { controlEnabled });
      deviceIdsBySerial.set(sn, built);
      return {
        name: `EcoFlow ${sn}`,
        external_id: built.device_external_id,
        params: [{ name: "SERIAL_NUMBER", value: sn }],
        features: built.features,
      };
    });
    await gladys.publishDiscoveredDevices(discovered);
    return;
  }

  if (!restClient) {
    logger.warn("EcoFlow: scan requested but no Access Key / Secret Key configured yet.");
    await gladys.publishDiscoveredDevices([]);
    return;
  }

  const devices = await restClient.listDevices();
  const discovered = [];

  for (const device of devices) {
    if (!device.sn) continue;
    const built = buildDeviceFeatures(gladys, device.sn, { controlEnabled });
    deviceIdsBySerial.set(device.sn, built);
    discovered.push({
      name: device.productName ? `EcoFlow ${device.productName} (${device.sn})` : `EcoFlow ${device.sn}`,
      external_id: built.device_external_id,
      params: [{ name: "SERIAL_NUMBER", value: device.sn }],
      features: built.features,
    });
  }

  await gladys.publishDiscoveredDevices(discovered);

  // Track every serial we discovered so polling can start even before the
  // user has explicitly filled the "serial_number" config field.
  knownSerials = Array.from(new Set([...knownSerials, ...devices.map((d) => d.sn).filter(Boolean)]));
  restartPolling();
});

gladys.onSetValue(async (device, feature, value) => {
  if (!controlEnabled) {
    throw new Error(
      "Control is disabled. Set enable_control=true in the configuration to enable it (advanced/experimental, see documentation).",
    );
  }

  const sn = (device.params || []).find((p) => p.name === "SERIAL_NUMBER");
  if (!sn) {
    throw new Error("Device is missing its SERIAL_NUMBER param, cannot send a command.");
  }

  if (connectionMode === "app_login") {
    // Real commands sourced from tolwi/hassio-ecoflow-cloud's own River2
    // device definition (devices/internal/river2.py) — the same mature
    // project whose "get latest quotas" request format was confirmed
    // working tonight. UNTESTED against a real device for these specific
    // set commands — test cautiously, one feature at a time, starting
    // with AC (easily reversible) before anything charge-power related.
    if (!mqttClient) {
      throw new Error("MQTT client not connected yet.");
    }
    if (feature.external_id.endsWith(":ac_output")) {
      await mqttClient.sendSetCommand(sn.value, 5, "acOutCfg", {
        enabled: value ? 1 : 0,
        out_voltage: -1,
        out_freq: 255,
        xboost: 255,
      });
    } else if (feature.external_id.endsWith(":car_output")) {
      await mqttClient.sendSetCommand(sn.value, 5, "mpptCar", { enabled: value ? 1 : 0 });
    } else if (feature.external_id.endsWith(":backup_reserve_enabled")) {
      // Mirrors tolwi/hassio-ecoflow-cloud's BP_ENABLED switch exactly,
      // including its slightly unusual "bpPowerSoc: value*50" — toggling
      // ON sets a default reserve of 50%, toggling OFF sends 0. Use the
      // dedicated set_backup_reserve_level action afterwards to pick a
      // real level once enabled.
      await mqttClient.sendSetCommand(sn.value, 1, "watthConfig", {
        isConfig: value ? 1 : 0,
        bpPowerSoc: value ? 50 : 0,
        minDsgSoc: 0,
        minChgSoc: 0,
      });
    } else {
      throw new Error("No control command implemented for this feature in app-login mode yet.");
    }

    // CONFIRMED live tonight: this device can silently ignore a command
    // for its own real-world reasons (e.g. no AC input plugged in) —
    // publishing the REQUESTED value as if it had succeeded would show a
    // state the device was never actually in. Instead, ask the device
    // for its real current state right away (rather than waiting for the
    // next 15s periodic poll) and let the normal MQTT update pipeline
    // (onQuotaUpdate → publishStateFromQuota) publish whatever comes
    // back — true either way, succeeded or not.
    setTimeout(() => mqttClient.requestLatestQuota(sn.value), 2000);
  } else {
    if (feature.external_id.endsWith(":ac_output") && acCommandCode) {
      await restClient.setQuota(sn.value, acCommandCode, { enabled: value ? 1 : 0 });
    } else if (feature.external_id.endsWith(":car_output") && carCommandCode) {
      await restClient.setQuota(sn.value, carCommandCode, { enabled: value ? 1 : 0 });
    } else {
      throw new Error("No command code configured for this feature.");
    }
    await gladys.publishState(feature.external_id, value);
  }
});

gladys.onAction("dump_raw_quota", async () => {
  if (connectionMode !== "app_login" || !mqttClient) {
    return "Cette action de debug ne s'applique qu'au mode connexion appli (MQTT).";
  }
  if (knownSerials.length === 0) {
    return "Aucun numéro de série configuré.";
  }
  const sn = knownSerials[0];
  const quota = mqttClient.getQuota(sn);
  logger.info(`EcoFlow app-login: accumulated quota for ${sn}: ${JSON.stringify(quota)}`);
  const keys = Object.keys(quota);
  return `${keys.length} champ(s) reçu(s) pour ${sn} jusqu'ici. Payload complet dans les Journaux de l'intégration.`;
});

gladys.onAction("set_solar_energy_total", async (fields) => {
  if (connectionMode !== "app_login") {
    return { en: "This action only applies to App login mode.", fr: "Cette action ne s'applique qu'au mode Connexion appli." };
  }
  if (knownSerials.length === 0) {
    return { en: "No serial number configured.", fr: "Aucun numéro de série configuré." };
  }
  const wh = Number(fields.wh);
  if (!Number.isFinite(wh) || wh < 0) {
    return { en: "The value must be a non-negative number of Wh.", fr: "La valeur doit être un nombre de Wh positif ou nul." };
  }
  const sn = knownSerials[0];
  // Overwrite in memory AND persist immediately (not throttled like the
  // regular quota-driven path) — this is a deliberate, one-off correction
  // the user is actively waiting to see take effect, not a routine update.
  solarAggregateBySerial.set(sn, { totalWh: wh, lastSampleAtMs: null });
  lastSolarPersistAtMs = 0;
  await maybePersistSolarAggregate();
  return {
    en: `Solar energy counter set to ${(wh / 1000).toFixed(3)} kWh for ${sn}.`,
    fr: `Compteur d'énergie solaire réglé sur ${(wh / 1000).toFixed(3)} kWh pour ${sn}.`,
  };
});

gladys.onAction("set_ac_charging_power", async (fields) => {
  if (!controlEnabled) {
    return { en: "Control is disabled — enable it in the configuration first.", fr: "Le contrôle est désactivé — activez-le d'abord dans la configuration." };
  }
  if (connectionMode !== "app_login" || !mqttClient) {
    return { en: "This action only applies to App login mode.", fr: "Cette action ne s'applique qu'au mode Connexion appli." };
  }
  if (knownSerials.length === 0) {
    return { en: "No serial number configured.", fr: "Aucun numéro de série configuré." };
  }
  const watts = Number(fields.watts);
  if (!Number.isFinite(watts) || watts < 100 || watts > 360) {
    return { en: "Charging power must be between 100 and 360 W.", fr: "La puissance de charge doit être comprise entre 100 et 360 W." };
  }
  const sn = knownSerials[0];
  // Real command sourced from tolwi/hassio-ecoflow-cloud's River2 device
  // definition — moduleType 5 "acChgCfg", chgPauseFlag:255 mirrors what
  // that project sends alongside the wattage (its exact meaning wasn't
  // investigated further, kept as-is to match a known-working command
  // shape rather than guess at a simplified one).
  await mqttClient.sendSetCommand(sn, 5, "acChgCfg", { chgWatts: Math.round(watts), chgPauseFlag: 255 });
  return { en: `AC charging power limit set to ${watts} W.`, fr: `Limite de puissance de charge AC réglée sur ${watts} W.` };
});

gladys.onAction("set_max_charge_level", async (fields) => {
  if (!controlEnabled) {
    return { en: "Control is disabled — enable it in the configuration first.", fr: "Le contrôle est désactivé — activez-le d'abord dans la configuration." };
  }
  if (connectionMode !== "app_login" || !mqttClient) {
    return { en: "This action only applies to App login mode.", fr: "Cette action ne s'applique qu'au mode Connexion appli." };
  }
  if (knownSerials.length === 0) {
    return { en: "No serial number configured.", fr: "Aucun numéro de série configuré." };
  }
  const percent = Number(fields.percent);
  if (!Number.isFinite(percent) || percent < 50 || percent > 100) {
    return { en: "Max charge level must be between 50 and 100%.", fr: "Le niveau de charge max doit être compris entre 50 et 100%." };
  }
  const sn = knownSerials[0];
  await mqttClient.sendSetCommand(sn, 2, "upsConfig", { maxChgSoc: Math.round(percent) });
  return { en: `Max charge level set to ${percent}%.`, fr: `Niveau de charge max réglé sur ${percent}%.` };
});

gladys.onAction("set_min_discharge_level", async (fields) => {
  if (!controlEnabled) {
    return { en: "Control is disabled — enable it in the configuration first.", fr: "Le contrôle est désactivé — activez-le d'abord dans la configuration." };
  }
  if (connectionMode !== "app_login" || !mqttClient) {
    return { en: "This action only applies to App login mode.", fr: "Cette action ne s'applique qu'au mode Connexion appli." };
  }
  if (knownSerials.length === 0) {
    return { en: "No serial number configured.", fr: "Aucun numéro de série configuré." };
  }
  const percent = Number(fields.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 30) {
    return { en: "Min discharge level must be between 0 and 30%.", fr: "Le niveau de décharge min doit être compris entre 0 et 30%." };
  }
  const sn = knownSerials[0];
  await mqttClient.sendSetCommand(sn, 2, "dsgCfg", { minDsgSoc: Math.round(percent) });
  return { en: `Min discharge level set to ${percent}%.`, fr: `Niveau de décharge min réglé sur ${percent}%.` };
});

gladys.onAction("set_backup_reserve_level", async (fields) => {
  if (!controlEnabled) {
    return { en: "Control is disabled — enable it in the configuration first.", fr: "Le contrôle est désactivé — activez-le d'abord dans la configuration." };
  }
  if (connectionMode !== "app_login" || !mqttClient) {
    return { en: "This action only applies to App login mode.", fr: "Cette action ne s'applique qu'au mode Connexion appli." };
  }
  if (knownSerials.length === 0) {
    return { en: "No serial number configured.", fr: "Aucun numéro de série configuré." };
  }
  const percent = Number(fields.percent);
  if (!Number.isFinite(percent) || percent < 5 || percent > 100) {
    return { en: "Backup reserve level must be between 5 and 100%.", fr: "Le niveau de réserve de secours doit être compris entre 5 et 100%." };
  }
  const sn = knownSerials[0];
  await mqttClient.sendSetCommand(sn, 1, "watthConfig", {
    isConfig: 1,
    bpPowerSoc: Math.round(percent),
    minDsgSoc: 0,
    minChgSoc: 0,
  });
  return { en: `Backup reserve level set to ${percent}%.`, fr: `Niveau de réserve de secours réglé sur ${percent}%.` };
});

gladys.onConfigUpdated(async () => {
  await reconfigure();
});

gladys.handleShutdown(async () => {
  if (pollTimer) clearInterval(pollTimer);
  if (mqttClient) mqttClient.disconnect();

  // Force a final save regardless of SOLAR_PERSIST_INTERVAL_MS's throttle
  // — a graceful shutdown is exactly the kind of window worth spending
  // one extra API call on, to avoid losing accumulated solar energy on
  // every restart/redeploy. Bounded by a timeout: CONFIRMED live
  // (2026-09-09) that losing the counter on every stop was a real,
  // recurring problem — better to give up after a few seconds than risk
  // this handler hanging and preventing the container from ever
  // finishing shutdown at all.
  lastSolarPersistAtMs = 0;
  await Promise.race([
    maybePersistSolarAggregate(),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]).catch((err) => logger.warn("EcoFlow: final shutdown save failed", err));

  // A GRACEFUL shutdown (docker stop, container restart from a config
  // reload) is the ONLY case where this is possible at all: the websocket
  // to Gladys is still alive right up until this handler finishes, so
  // there's a real channel to push through. An ABRUPT disconnect (network
  // blip, close code 1006, a crash) offers no such window — by the time
  // that event fires, the channel is already down, so nothing can be sent
  // at that moment. That half genuinely cannot be fixed from this
  // integration's code; the reconnect-then-republish flow below is the
  // closest available mitigation (minimizes, doesn't eliminate, the stale
  // window).
  //
  // EXPERIMENTAL: explicitly reset every feature to null right before
  // going down, on the chance Gladys renders a null state the same way as
  // a feature that has never received one ("Pas de valeur récente") rather
  // than literally displaying "null". UNCONFIRMED — check the dashboard
  // after a clean `docker stop` to see what actually renders.
  for (const [sn, cached] of deviceIdsBySerial.entries()) {
    const resetUpdates = cached.features.map((f) => ({
      device_feature_external_id: f.external_id,
      state: null,
    }));
    try {
      await gladys.publishStates(resetUpdates);
      logger.info(`EcoFlow (${sn}): reset all feature values to null before shutdown`);
    } catch (err) {
      logger.warn(`EcoFlow (${sn}): failed to reset feature values before shutdown`, err);
    }
  }
  try {
    await gladys.setConnectionStatus(false, {
      en: "Integration stopped (container shutdown).",
      fr: "Intégration arrêtée (arrêt du conteneur).",
    });
  } catch (err) {
    logger.warn("Failed to report disconnected status during shutdown", err);
  }
});

(async () => {
  await reconfigure();
  await gladys.connect();
})().catch((err) => {
  logger.error("EcoFlow integration failed to start", err);
  process.exit(1);
});
