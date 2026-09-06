"use strict";

/**
 * Loads a fresh copy of src/index.js with the Gladys SDK and the EcoFlow
 * app-login MQTT client replaced by controllable fakes — needed because
 * index.js runs top-level side effects (gladys.onConfigUpdated(...), etc.)
 * as soon as it's required, and Node caches modules by default, so every
 * test needs its own clean, uncached load with its own fresh mocks.
 *
 * @param {object} options
 * @param {object} options.config - what gladys.getConfig() resolves to.
 * @param {object} [options.mqttClientOverrides] - methods to override on
 *   the fake EcoflowAppMqttClient instance (e.g. connect, sendSetCommand).
 * @returns {{ gladys, mqtt, published, publishedStates, setConfigCalls, actions, onSetValueHandler }}
 */
async function loadIndexWithMocks({ config, mqttClientOverrides = {} } = {}) {
  const Module = require("module");
  const path = require("path");

  const state = {
    published: [], // every publishStates() call, as [{ device_feature_external_id, state }, ...]
    publishedStates: [], // every publishState() (singular, optimistic) call, as { id, value }
    setConfigCalls: [], // every gladys.setConfig() partial payload
    actions: {}, // key -> handler registered via gladys.onAction(key, handler)
    onSetValueHandler: null,
    connectionStatus: [], // every setConnectionStatus(...) call
    mqttInstances: [],
  };

  class FakeMqttClient {
    constructor(opts) {
      this.opts = opts;
      this._quotaHandler = null;
      state.mqttInstances.push(this);
      Object.assign(this, mqttClientOverrides);
    }
    onQuotaUpdate(cb) {
      this._quotaHandler = cb;
    }
    async connect() {
      if (this.connect === FakeMqttClient.prototype.connect) return;
    }
    disconnect() {}
    getQuota() {
      return {};
    }
    sendSetCommand() {
      return Promise.resolve();
    }
    requestLatestQuota() {}
    // Test helper, not part of the real client's API: lets a test simulate
    // an incoming MQTT quota update directly.
    _emitQuota(sn, quota) {
      if (this._quotaHandler) this._quotaHandler(sn, quota);
    }
  }

  class FakeGladys {
    async getConfig() {
      return config || {};
    }
    async publishStates(states) {
      state.published.push(...states);
    }
    async publishState(id, value) {
      state.publishedStates.push({ id, value });
    }
    async publishDiscoveredDevices() {}
    setConnectionStatus(ok, err) {
      state.connectionStatus.push({ ok, err });
    }
    onScanRequest() {}
    onConfigUpdated() {}
    onSetValue(cb) {
      state.onSetValueHandler = cb;
    }
    onAction(key, cb) {
      state.actions[key] = cb;
    }
    handleShutdown() {}
    async connect() {}
    async setConfig(partial) {
      state.setConfigCalls.push(partial);
      return { success: true };
    }
    externalIds(type, id) {
      return {
        device: `ext:${type}:${id}`,
        feature: (key) => `ext:${type}:${id}:${key}`,
      };
    }
  }

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@gladysassistant/integration-sdk") {
      return {
        GladysIntegration: FakeGladys,
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        DEVICE_FEATURE_CATEGORIES: {
          BATTERY_STORAGE: "battery-storage",
          TEXT: "text",
          SWITCH: "switch",
          DURATION: "duration",
          HOME_OUTPUT_SENSOR: "home-output-sensor",
          ENERGY_PRODUCTION_SENSOR: "energy-production-sensor",
          CURRENCY: "currency",
        },
        DEVICE_FEATURE_TYPES: {
          BATTERY_STORAGE: { BATTERY_LEVEL: "battery-level", CHARGE_POWER: "charge-power", DISCHARGE_POWER: "discharge-power" },
          SWITCH: { BINARY: "binary" },
          TEXT: { TEXT: "text" },
          DURATION: { INTEGER: "integer" },
          HOME_OUTPUT_SENSOR: { POWER: "power" },
          ENERGY_PRODUCTION_SENSOR: { INDEX: "index" },
          CURRENCY: { DECIMAL: "decimal" },
        },
        DEVICE_FEATURE_UNITS: { PERCENT: "%", WATT: "W", MINUTES: "min", KILOWATT_HOUR: "kWh", EURO: "EUR" },
      };
    }
    if (request === "./ecoflow-app-mqtt-client" || request.endsWith("ecoflow-app-mqtt-client")) {
      return { EcoflowAppMqttClient: FakeMqttClient };
    }
    if (request === "./ecoflow-client" || request.endsWith("ecoflow-client")) {
      return {
        EcoflowClient: class {
          async getQuota() {
            return {};
          }
          async setQuota() {}
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const indexPath = require.resolve(path.join(__dirname, "..", "..", "src", "index.js"));
    delete require.cache[indexPath];
    require(indexPath);
  } finally {
    Module._load = originalLoad;
  }

  // index.js kicks off `(async () => { await reconfigure(); await gladys.connect(); })()`
  // as a top-level side effect the instant it's required — there is no
  // handle to await it directly, so give it a short tick to actually run
  // before tests inspect the resulting state (mirrors the same pattern
  // used repeatedly, successfully, throughout tonight's manual testing).
  await new Promise((resolve) => setTimeout(resolve, 50));

  return state;
}

module.exports = { loadIndexWithMocks };
