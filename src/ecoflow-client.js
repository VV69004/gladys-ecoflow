"use strict";

const crypto = require("crypto");
const { logger } = require("@gladysassistant/integration-sdk");

const log = logger.child ? logger.child("ecoflow-api") : logger;

/**
 * Minimal client for the official EcoFlow Developer (Public) API.
 *
 * Docs: https://developer-eu.ecoflow.com/us/document/introduction
 *
 * The signing scheme requires flattening nested objects/arrays into
 * dot/bracket-notation keys, sorting them alphabetically, building a query
 * string, appending accessKey/nonce/timestamp, then HMAC-SHA256 (hex) with
 * the secret key.
 */

const REGIONS = {
  eu: "https://api-e.ecoflow.com",
  us: "https://api-a.ecoflow.com",
};

function flatten(value, parentKey = "") {
  const items = [];

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const key = `${parentKey}[${index}]`;
      if (item !== null && typeof item === "object") {
        items.push(...flatten(item, key));
      } else {
        items.push([key, stringifyScalar(item)]);
      }
    });
    return items;
  }

  if (value !== null && typeof value === "object") {
    Object.keys(value).forEach((k) => {
      const key = parentKey ? `${parentKey}.${k}` : k;
      const v = value[k];
      if (v !== null && typeof v === "object") {
        items.push(...flatten(v, key));
      } else {
        items.push([key, stringifyScalar(v)]);
      }
    });
    return items;
  }

  return items;
}

function stringifyScalar(v) {
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  if (v === null || v === undefined) {
    return "";
  }
  return String(v);
}

class EcoflowClient {
  /**
   * @param {object} options
   * @param {string} options.accessKey
   * @param {string} options.secretKey
   * @param {"eu"|"us"} [options.region]
   * @param {number} [options.timeoutMs]
   */
  constructor({ accessKey, secretKey, region = "eu", timeoutMs = 10000 }) {
    if (!accessKey || !secretKey) {
      throw new Error("EcoflowClient requires accessKey and secretKey");
    }
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.baseUrl = REGIONS[region] || REGIONS.eu;
    this.timeoutMs = timeoutMs;
  }

  _sign(params) {
    const nonce = String(Math.floor(100000 + Math.random() * 900000));
    const timestamp = String(Date.now());

    const flat = flatten(params || {});
    flat.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let qs = flat.map(([k, v]) => `${k}=${v}`).join("&");
    if (qs.length > 0) qs += "&";

    const plain = `${qs}accessKey=${this.accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
    const sign = crypto.createHmac("sha256", this.secretKey).update(plain, "utf8").digest("hex");

    return {
      accessKey: this.accessKey,
      nonce,
      timestamp,
      sign,
    };
  }

  async _request(method, path, { query, body } = {}) {
    const headers = this._sign(method === "GET" ? query : body);
    const url = new URL(`${this.baseUrl}${path}`);

    if (method === "GET" && query) {
      Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          "Content-Type": "application/json",
          accessKey: headers.accessKey,
          nonce: headers.nonce,
          timestamp: headers.timestamp,
          sign: headers.sign,
        },
        body: method === "GET" ? undefined : JSON.stringify(body || {}),
        signal: controller.signal,
      });

      const json = await response.json().catch(() => null);

      if (!response.ok || !json) {
        throw new Error(`EcoFlow API HTTP ${response.status} on ${path}`);
      }

      // EcoFlow wraps every response as { code, message, data }. code "0" = success.
      if (json.code !== "0" && json.code !== 0) {
        const err = new Error(`EcoFlow API error ${json.code}: ${json.message}`);
        err.ecoflowCode = json.code;
        throw err;
      }

      return json.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** List every device bound to the account. Returns [{ sn, online, productName }]. */
  async listDevices() {
    const data = await this._request("GET", "/iot-open/sign/device/list");
    return Array.isArray(data) ? data : [];
  }

  /**
   * Read the full (or partial) quota for a device.
   * Passing no `quotas` array returns everything the device currently reports.
   * @param {string} sn
   * @param {string[]} [quotas]
   */
  async getQuota(sn, quotas) {
    const body = quotas && quotas.length > 0 ? { sn, params: { quotas } } : { sn, params: {} };
    const data = await this._request("POST", "/iot-open/sign/device/quota", { body });
    return data || {};
  }

  /**
   * Send a generic set-quota command.
   * @param {string} sn
   * @param {string} cmdCode - e.g. "WN511_SOC_SET"
   * @param {object} params
   */
  async setQuota(sn, cmdCode, params) {
    const body = { sn, cmdCode, params };
    return this._request("PUT", "/iot-open/sign/device/quota", { body });
  }
}

module.exports = { EcoflowClient, flatten };
