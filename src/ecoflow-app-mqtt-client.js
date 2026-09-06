"use strict";

const mqtt = require("mqtt");
const crypto = require("crypto");
const { logger } = require("@gladysassistant/integration-sdk");

const log = logger.child ? logger.child("ecoflow-app-mqtt") : logger;

// CONFIRMED BUG (2026-09-02, live against a real French/EU EcoFlow account):
// EcoFlow strictly separates accounts by region at the infrastructure level.
// The community `ecoflow_mqtt_credentials` npm package always posts the
// login request to the GLOBAL/US host (api.ecoflow.com), with no region
// option — for an EU-registered account, that host correctly returns
// `code 2026 "Account doesn't exist or incorrect password"` even with 100%
// correct credentials, because the account genuinely does not exist on
// THAT specific regional backend. This matches an independently-documented
// note from another EcoFlow Home Assistant integration's README ("EcoFlow
// strictly separates accounts by region... Europe: api-e.ecoflow.com").
// Fix: implement the same two HTTP calls ourselves, respecting the same
// "region" config field already used for the Developer API client
// (ecoflow-client.js), instead of depending on a package that only ever
// targets the global host.
const REGIONS = {
  eu: "https://api-e.ecoflow.com",
  us: "https://api.ecoflow.com",
};

async function login(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // CONFIRMED working, realistic device identification (2026-09-03) —
      // a real working setup guide (~4 months of reliable operation
      // reported) uses "os":"android", "osVersion":"30" (a real Android
      // API level), "appVersion":"4.2.3.12" (a real EcoFlow app version).
      // The previous values here ("linux", "1.0.0",
      // "5.15.90.1-kali-fake" — literally containing the word "fake",
      // copied verbatim from a community package's example code) looked
      // nothing like a genuine Android app request. UNCONFIRMED whether
      // EcoFlow's backend actually filters on this, but it's a real,
      // previously-unexamined difference between our request and a
      // reliably-working real-world one, worth fixing regardless.
      os: "android",
      scene: "IOT_APP",
      appVersion: "4.2.3.12",
      osVersion: "30",
      password: Buffer.from(password, "utf8").toString("base64"),
      oauth: { bundleId: "com.ef.EcoFlow" },
      email,
      userType: "ECOFLOW",
    }),
  });
  const json = await response.json().catch(() => null);
  if (!json || !json.data || !json.data.token) {
    const detail = json ? `${json.code}: ${json.message}` : `HTTP ${response.status}`;
    throw new Error(`EcoFlow app login failed (${detail}) — check email/password and region`);
  }
  return { userId: json.data.user.userId, token: json.data.token };
}

async function getMqttCertificate(baseUrl, token) {
  const response = await fetch(`${baseUrl}/iot-auth/app/certification`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => null);
  if (!json || !json.data) {
    const detail = json ? `${json.code}: ${json.message}` : `HTTP ${response.status}`;
    throw new Error(`EcoFlow MQTT certification failed (${detail})`);
  }
  return json.data;
}

// Extracts the device serial number from the one confirmed-working topic
// shape: /app/device/property/<SN> -> SN is the last segment. (Two other
// candidate topic shapes were tried and explicitly rejected by the broker
// for this account — see the class doc comment above — so this no longer
// needs to handle their differing SN position.)
function extractSerialFromTopic(topic) {
  const parts = topic.split("/").filter(Boolean); // drop the leading "" from a leading "/"
  if (parts.length >= 4 && parts[0] === "app" && parts[1] === "device" && parts[2] === "property") {
    return parts[3];
  }
  return null; // unrecognized topic shape — caller logs and ignores the message
}

/**
 * UNOFFICIAL connection mode: authenticates with the same email/password as
 * the EcoFlow mobile app (NOT Developer API keys), then connects directly to
 * EcoFlow's own MQTT broker and subscribes to the device's raw status topic
 * — the same thing the app itself does internally.
 *
 * WHY THIS EXISTS: the official Developer (Public) REST API's documented
 * device catalog (https://developer-eu.ecoflow.com/us/document/introduction)
 * does NOT list the plain "River 2" — only "River 2 Pro" — confirmed live
 * tonight against a real account with correctly-configured Developer API
 * keys, which consistently returned `error 1006: current device is not
 * allowed to get device info` for a base River 2. This is a real gap in
 * EcoFlow's own public API, not a bug in this integration or a config
 * mistake — see docs/fr.md for the full troubleshooting trail.
 *
 * This path only ever reads telemetry (no SET support yet — see
 * onSetValue's app_login branch in index.js). It is inherently more
 * fragile than the official API: unversioned, can break on any EcoFlow
 * app/server change, and is not something EcoFlow supports or endorses.
 *
 * Credit: the login → certificate → MQTT flow below follows the same shape
 * documented by community reverse-engineering (e.g. @mmiller7's
 * ecoflow-withoutflow project, and the `ecoflow_mqtt_credentials` npm
 * package) — reimplemented directly here (rather than depending on that
 * package) specifically to fix a confirmed regional bug: that package
 * always targets the global/US login host regardless of account region,
 * which incorrectly rejects EU-registered accounts with "Account doesn't
 * exist or incorrect password" (EcoFlow's own error code 2026) even with
 * fully correct credentials. See REGIONS above.
 *
 * MESSAGE FORMAT: CONFIRMED live against a real River 2 on 2026-09-02 (175
 * fields captured over /app/device/property/<SN> alone — the only one of 3
 * candidate topics this account is actually authorized for; the other two
 * ("/app/<userId>/<SN>/thing/property" and "/open/<certificateAccount>/<SN>
 * /quota") were explicitly REJECTED by the broker with MQTT reason code 128
 * — so only the first topic is subscribed to below). Each message is a
 * PARTIAL update (a handful of dotted-key fields, not a full snapshot):
 *   {"id":1330299617613842767,"version":"1.0","timestamp":1669603258,
 *    "moduleType":"1","params":{"pd.carTemp":36}}
 * — this client merges every incoming `params` into a running quota object
 * per device, so a field only reported occasionally isn't lost between
 * messages. Telemetry frequency varies by module and can take several
 * minutes to first arrive for some fields — this is normal, not a bug.
 */
class EcoflowAppMqttClient {
  constructor({ email, password, region = "eu" }) {
    if (!email || !password) {
      throw new Error("EcoflowAppMqttClient requires email and password");
    }
    this.email = email;
    this.password = password;
    this.baseUrl = REGIONS[region] || REGIONS.eu;
    this.mqttClient = null;
    this.quotaBySerial = new Map(); // sn -> merged quota object (accumulated across messages)
    this.listeners = []; // (sn, mergedQuota) => void
    this.connected = false;
    this.pokeTimer = null;
    this.watchdogTimer = null;
    this.lastMessageAt = 0;
    this._serialNumbers = [];
  }

  /** @param {(sn: string, mergedQuota: object) => void} listener */
  onQuotaUpdate(listener) {
    this.listeners.push(listener);
  }

  /** Last known merged quota for a device — used by the debug action. */
  /**
   * One-shot version of the periodic "get latest quotas" poke — same
   * confirmed-working request, but triggered on demand rather than
   * waiting for the next 15s cycle. Used right after a control command is
   * sent, so the real device state (not an assumed/optimistic one) comes
   * back and gets published to Gladys as soon as realistically possible.
   */
  requestLatestQuota(sn) {
    const getTopic = this.getTopicsBySerial && this.getTopicsBySerial.get(sn);
    if (!this.mqttClient || !getTopic) return;
    const requestPayload = JSON.stringify({
      version: "1.1",
      moduleType: 0,
      operateType: "latestQuotas",
      params: {},
    });
    this.mqttClient.publish(getTopic, requestPayload, (err) => {
      if (err) {
        log.warn(`"get latest quotas" publish to ${getTopic} failed`, err);
      } else {
        log.info(`"get latest quotas" published to ${getTopic}`);
      }
    });
  }

  getQuota(sn) {
    return this.quotaBySerial.get(sn) || {};
  }

  /**
   * Sends a real control command over MQTT — CONFIRMED format and topic,
   * read directly from tolwi/hassio-ecoflow-cloud's own real, maintained
   * source (api/private_api.py's set_topic + api/message.py's
   * JSONMessage envelope), the same mature project whose "get latest
   * quotas" request tonight was confirmed to work reliably without the
   * mobile app. UNTESTED against a real device tonight — this is new,
   * write access to physical hardware, so start with the most reversible
   * command (AC output) and watch the device respond before trusting it
   * for anything else. A real, fully hardware-level factory reset (hold
   * the AC and DC buttons together for ~5s — confirmed for the base
   * River 2's actual 3-button front panel: power, AC, DC) remains
   * available regardless of anything this method does — see docs/fr.md.
   *
   * @param {string} sn
   * @param {number} moduleType
   * @param {string} operateType
   * @param {object} params
   */
  sendSetCommand(sn, moduleType, operateType, params) {
    if (!this.mqttClient || !this.userId) {
      throw new Error("Not connected — cannot send a set command yet.");
    }
    const setTopic = `/app/${this.userId}/${sn}/thing/property/set`;
    const payload = JSON.stringify({
      from: "Gladys",
      id: String(999900000 + Math.floor(Math.random() * 90000) + 10000),
      version: "1.0",
      moduleType,
      operateType,
      params,
    });
    return new Promise((resolve, reject) => {
      this.mqttClient.publish(setTopic, payload, (err) => {
        if (err) {
          log.error(`Set command publish to ${setTopic} failed`, err);
          reject(err);
        } else {
          log.info(`Set command published to ${setTopic}: ${operateType} ${JSON.stringify(params)}`);
          resolve();
        }
      });
    });
  }

  /** @param {string[]} serialNumbers */
  async connect(serialNumbers) {
    this._serialNumbers = serialNumbers;
    const { userId, token } = await login(this.baseUrl, this.email, this.password);
    const cert = await getMqttCertificate(this.baseUrl, token);

    // Close out any previous session before opening a fresh one — a stale
    // connection lingering in parallel would just be wasted overhead, and
    // could plausibly count as "another simultaneous client" against
    // whatever session limit EcoFlow's broker enforces.
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }

    // CONFIRMED root cause (2026-09-02, via tolwi/hassio-ecoflow-cloud's own
    // source code comment — a mature, widely-used working integration):
    // "only 10 unique client IDs are allowed per day" on EcoFlow's MQTT
    // broker. Every previous version of this file called crypto.randomUUID()
    // on EVERY connection — including the periodic re-auth cycle added
    // earlier tonight, which made things WORSE by burning through the quota
    // even faster. This exactly explains the whole evening: the first
    // connection worked (still within quota), every reconnect after that
    // got a brand new, never-before-seen client ID and silently stopped
    // receiving messages (subscribe still succeeds — quota enforcement
    // appears to be a MESSAGE-DELIVERY-level cutoff, not a CONNECT/SUBSCRIBE
    // rejection), and the real mobile app kept working throughout because it
    // uses ITS OWN stable, long-lived client identity, never affected by our
    // quota usage. Fixed: derive a STABLE id from the account's own email
    // (deterministic, same value on every run — including across container
    // restarts) instead of a fresh random one each time.
    //
    // Formatted as a real UUIDv4 (with dashes and the correct version/variant
    // nibbles) rather than a raw hex string — matches exactly what
    // crypto.randomUUID() would produce, so it's indistinguishable in shape
    // from a genuine Android installation id, in case EcoFlow's backend
    // validates the client id's format.
    const hash = crypto.createHash("sha256").update(this.email).digest("hex");
    const stableUuid = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      `4${hash.slice(13, 16)}`, // version nibble = 4
      `${((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`, // variant nibble
      hash.slice(20, 32),
    ].join("-");
    const clientId = `ANDROID_${stableUuid}_${userId}`;
    const url = `${cert.protocol}://${cert.url}:${cert.port}`;
    this.userId = userId; // stored for sendSetCommand()'s topic construction

    return new Promise((resolve, reject) => {
      this.mqttClient = mqtt.connect(url, {
        clientId,
        username: cert.certificateAccount,
        password: cert.certificatePassword,
        reconnectPeriod: 5000,
        connectTimeout: 15000,
      });

      let settled = false;

      this.mqttClient.on("connect", () => {
        this.connected = true;
        log.info(`Connected to EcoFlow MQTT broker (${cert.url})`);
        for (const sn of serialNumbers) {
          // CONFIRMED live tonight: only this ONE topic is authorized for
          // this account — two other candidate topics were tried earlier
          // and explicitly rejected by the broker (reason code 128). An
          // explicit QoS 1 option was also tried and tested WORSE (no data
          // arrived at all) than the default (no explicit qos) used here.
          const topic = `/app/device/property/${sn}`;
          this.mqttClient.subscribe(topic, (err) => {
            if (err) {
              log.error(`Failed to subscribe to ${topic}`, err);
            } else {
              log.info(`Subscribed to ${topic}`);
            }
          });

          // CORRECTED 2026-09-06: replaces an earlier, entirely invented
          // "poke" (a made-up payload sent to the passive broadcast topic
          // itself, which we later confirmed was just echoing back to us).
          // This version is instead
          // read directly from tolwi/hassio-ecoflow-cloud's real,
          // maintained source (api/private_api.py + devices/__init__.py) —
          // a mature, widely-used integration that reverse-engineered
          // EcoFlow's actual internal app API:
          //   - the real "get latest quota" request body is
          //     {version:"1.1", moduleType:0, operateType:"latestQuotas", params:{}}
          //   - it is published to a DEDICATED per-user get topic —
          //     /app/{userId}/{deviceSn}/thing/property/get — NOT the
          //     broadcast topic above. This exact topic WITH the /get
          //     suffix was never tried before tonight; only the same path
          //     WITHOUT the suffix was tested earlier and rejected by the
          //     broker (reason code 128) — the suffix appears to be the
          //     actual missing piece.
          const getTopic = `/app/${userId}/${sn}/thing/property/get`;
          this.getTopicsBySerial = this.getTopicsBySerial || new Map();
          this.getTopicsBySerial.set(sn, getTopic);

          if (this.pokeTimer) clearInterval(this.pokeTimer);
          this.pokeTimer = setInterval(() => this.requestLatestQuota(sn), 15000);
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.mqttClient.on("message", (topic, payload) => {
        this._handleMessage(topic, payload);
      });

      this.mqttClient.on("error", (err) => {
        log.error("EcoFlow MQTT client error", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.mqttClient.on("close", () => {
        this.connected = false;
        if (this.pokeTimer) {
          clearInterval(this.pokeTimer);
          this.pokeTimer = null;
        }
      });
    });
  }

  _handleMessage(topic, payloadBuffer) {
    const sn = extractSerialFromTopic(topic);
    let message;
    try {
      message = JSON.parse(payloadBuffer.toString("utf8"));
    } catch (err) {
      log.warn(
        `Non-JSON MQTT message on ${topic} (${payloadBuffer.length} bytes) — first 200 hex chars: ${payloadBuffer.toString("hex").slice(0, 200)}`,
      );
      return;
    }

    if (!sn) {
      log.warn(`Could not extract a serial number from topic "${topic}" — message ignored`);
      return;
    }
    if (!message || typeof message.params !== "object" || message.params === null) {
      return;
    }

    // CONFIRMED BUG (2026-09-03, live): this client both PUBLISHES the
    // periodic active data request AND SUBSCRIBES to the exact same topic
    // — MQTT brokers generally echo a client's own publishes back to it if
    // it's subscribed to a matching topic (no "no local" flag set), so our
    // own request was being received back as if it were real device
    // telemetry and merged into the accumulated quota, polluting it with
    // an empty/meaningless "quotas" key and drowning out genuine data
    // right after a reconnect. Recognize and skip it: no real device
    // message observed tonight (many full captures) has ever used a bare
    // "quotas" key — only this client's own request payload does.
    const isOwnEchoedRequest =
      Object.keys(message.params).length === 1 && Array.isArray(message.params.quotas);
    if (isOwnEchoedRequest) {
      return;
    }

    const merged = this.quotaBySerial.get(sn) || {};
    Object.assign(merged, message.params);
    this.quotaBySerial.set(sn, merged);

    for (const listener of this.listeners) {
      listener(sn, merged);
    }
  }

  disconnect() {
    if (this.pokeTimer) {
      clearInterval(this.pokeTimer);
      this.pokeTimer = null;
    }
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
    this.connected = false;
  }
}

module.exports = { EcoflowAppMqttClient };
