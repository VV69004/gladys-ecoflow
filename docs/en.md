# EcoFlow integration for Gladys Assistant

Monitor your EcoFlow RIVER 2 portable power station from Gladys, using the
official EcoFlow Developer (Public) API. No cloud scraping, no unofficial
protocol: this talks to `api-e.ecoflow.com` (or `api-a.ecoflow.com` for the
US region) with your own Access Key / Secret Key.

## What you get

- Battery level (%)
- Charge power / discharge power (W)
- Power delivered to the home output (W)
- Estimated remaining runtime (minutes)
- Read-only AC output and 12V/car output state, exposed as switches

Control (turning outputs on/off from Gladys) is **disabled by default** and
clearly marked experimental: EcoFlow does not publish a documented list of
command codes ("cmdCode") for every device/firmware combination on the public
API, unlike the well-documented read side. See "Advanced: enable control"
below if you want to try it anyway.

## 1. Get EcoFlow Developer API credentials

1. Go to <https://developer-eu.ecoflow.com> (or the `.com` domain for the US)
   and create a free developer account, using the **same email** as your
   EcoFlow app account.
2. Create an application. Approval is not always instant — it can take a few
   days.
3. Once approved, generate an **Access Key** and a **Secret Key** from the
   developer portal.

## 2. Find your RIVER 2 serial number

Open the EcoFlow app, select your RIVER 2, go to **Settings**, and copy the
serial number (it looks like `R621ZEB4XXXXXXXX`).

## 3. Configure the integration

Fill in the region, Access Key, Secret Key, and (optionally) the serial
number. If you leave the serial number empty, running a **Scan** from the
Discovery tab will list every EcoFlow device on your account instead.

## 4. Discover and create the device

Open the **Discovery** tab, click **Scan**, and create the device that
appears. States update roughly every 30 seconds.

## Advanced: enable control (experimental)

If you want to try switching the AC or 12V output from Gladys, you need the
exact `cmdCode` EcoFlow's app uses for your specific device/firmware. This is
not published for every model. A common approach is to inspect network
traffic from the EcoFlow app (e.g. with a proxy tool) while toggling the
output, or search the community forums (Home Assistant `hassio-ecoflow-cloud`
project) for your exact model. Once you have it, fill the "AC output cmdCode"
and/or "12V/car output cmdCode" fields and turn on "Enable control". Until
then, the switches stay read-only and simply reflect the current state.

## Troubleshooting

- **"IoT Core service subscription has expired" / HTTP errors**: your
  developer app may need re-approval, or your Access/Secret Key are wrong.
- **Error code 1006 ("current device is not allowed to get device info")**:
  EcoFlow whitelists devices for public API access account by account; some
  users have had to email EcoFlow support with their serial number to get
  this unblocked, even with an approved developer account.
- No data after creating the device: wait for the next 30-second poll, then
  check the integration **Logs** tab for the exact EcoFlow API error.

## Limitations

- Read-only by default; control is experimental and unsupported by EcoFlow's
  public documentation.
- Some RIVER 2 firmware/regional variants may not report every field listed
  above; missing fields are simply skipped rather than causing an error.
- This uses the cloud API only (`transports: ["cloud"]`) — there is no local
  protocol documented for RIVER 2 on the public API.
