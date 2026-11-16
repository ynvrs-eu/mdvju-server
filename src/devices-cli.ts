/**
 * Edits the device registry (devices.ts) directly, for
 * scripts/pair-device.sh and scripts/devices.sh: in a one-off container of
 * the backend image for the live registry, on the host for the test one. A running backend picks
 * the change up on its next request: no restart, and no shared token
 * needed.
 *
 *   devices-cli pair <name>      new pairing code; prints its link
 *   devices-cli list             every device, revoked ones too
 *   devices-cli revoke <id>      revokes a device
 *   devices-cli rotate <id>      revokes it and prints a pairing link for the same name
 *   devices-cli qr <text>        prints <text> as a QR code for the terminal
 *   devices-cli demo-link        the demo server's reusable pairing link,
 *                                from DEMO_PAIRING_CODE and DEMO_PAIRING_EXPIRES; prints
 *                                the link, then its expiry on stderr
 *
 * Env: SECRETS_DIR (default ./secrets), PUBLIC_URL (the backend's URL as
 * the app reaches it; needed by pair and rotate, it goes into the link).
 *
 * Only `pair` and `rotate` print a secret (the pairing link, single-use,
 * 10 minutes), and `demo-link` the demo server's reusable one; nothing
 * prints a token, which only the paired device ever sees.
 */
import * as path from "path";
import qrcode from "qrcode-generator";
import { openRegistry, parseDemoPairing, type DeviceRegistry } from "./devices";
import { buildPairLink } from "../shared/pair-link";

function die(message: string): never {
  console.error(`devices-cli: ${message}`);
  process.exit(1);
}

function backendUrl(): string {
  const backend = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(backend)) die("set PUBLIC_URL to the backend's URL as the app reaches it (e.g. https://viewer.example.com)");
  return backend;
}

async function pairLink(registry: DeviceRegistry, name: string): Promise<string> {
  const backend = backendUrl();
  const { code } = await registry.createPairingCode(name, "cli");
  return buildPairLink({ code, backend, name });
}

async function main(args: string[]): Promise<void> {
  const [command, arg] = args;
  if (command === "qr") {
    if (!arg) die("usage: qr <text>");
    const qr = qrcode(0, "M");
    qr.addData(arg);
    qr.make();
    process.stdout.write(qr.createASCII(1, 2) + "\n");
    return;
  }
  if (command === "demo-link") {
    // The same checks the server makes at startup, so a link printed here
    // is one the server accepts. Touches no registry. No name in the link:
    // each device sends the app's default name.
    let demo;
    try {
      demo = parseDemoPairing(process.env);
    } catch (err) {
      die((err as Error).message);
    }
    if (!demo) die("set DEMO_PAIRING_CODE and DEMO_PAIRING_EXPIRES (the demo server's; env or .env)");
    const backend = backendUrl();
    const until = new Date(demo.expiresAt).toISOString();
    if (Date.now() >= demo.expiresAt) die(`the demo pairing code expired at ${until}`);
    console.log(buildPairLink({ code: demo.code, backend, name: null }));
    console.error(`expires ${until}`);
    return;
  }

  const registry = openRegistry(path.resolve(process.env.SECRETS_DIR ?? "secrets"), undefined, {
    onLockWait: () => console.error("devices.json is being written by the backend; waiting..."),
  });
  const nameOf = (id: string | null): string => {
    if (id === null) return "unknown";
    if (id === "cli") return "server";
    return registry.list().find((d) => d.id === id)?.name ?? id;
  };
  /** Re-reads the file: the revoke must still be there . */
  const confirmRevoked = (id: string): void => {
    if (registry.list().find((d) => d.id === id)?.revokedAt == null) die(`${id} is not revoked in ${registry.file} after writing it; run list and try again`);
  };
  switch (command) {
    case "pair": {
      if (!arg?.trim()) die("usage: pair <device name>");
      console.log(await pairLink(registry, arg));
      return;
    }
    case "list": {
      const devices = registry.list();
      if (devices.length === 0) {
        console.log(`no devices in ${registry.file}`);
        return;
      }
      for (const d of devices) {
        const status = d.revokedAt ? `revoked ${d.revokedAt}` : "active";
        console.log(
          `${d.id}  ${d.name.padEnd(24)}  paired ${d.createdAt} by ${nameOf(d.pairedBy)}  last seen ${d.lastSeenAt ?? "never"}  ${status}`,
        );
      }
      return;
    }
    case "revoke": {
      if (!arg) die("usage: revoke <id>");
      const device = await registry.revoke(arg);
      if (!device) die(`no active device ${arg} (see: list)`);
      confirmRevoked(device.id);
      console.log(`revoked ${device.id} (${device.name})`);
      return;
    }
    case "rotate": {
      if (!arg) die("usage: rotate <id>");
      const device = registry.list().find((d) => d.id === arg && d.revokedAt === null);
      if (!device) die(`no active device ${arg} (see: list)`);
      // The link first: if PUBLIC_URL is missing, nothing is revoked.
      const link = await pairLink(registry, device.name);
      await registry.revoke(device.id);
      confirmRevoked(device.id);
      console.error(`revoked ${device.id} (${device.name}); pair it again with:`);
      console.log(link);
      return;
    }
    default:
      die("usage: devices-cli pair <name> | list | revoke <id> | rotate <id> | qr <text> | demo-link");
  }
}

main(process.argv.slice(2)).catch((err: unknown) => die((err as Error).message));
