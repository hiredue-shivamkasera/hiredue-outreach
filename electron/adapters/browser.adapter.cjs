// Opens the Camoufox browser for one LinkedIn account's saved profile, and nothing else. It never installs or updates Camoufox: that install lives in the OS cache shared with hiredue-desktop-application, and camoufox-js wipes the whole cache whenever it fetches.

const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");
const { CAMOUFOX_PIN, TIMEOUT } = require("../constants.cjs");

// LinkedIn treats a changed device fingerprint on an existing session cookie as a hijack and logs the account out, so each profile keeps the one it was born with.
const IDENTITY_FILE = "camoufox-identity.json";
const OS_SHORT = { macos: "mac", windows: "win", linux: "lin" };
const hostOS = () => ({ darwin: "macos", win32: "windows" })[process.platform] || "linux";

// Only one browser may hold a profile directory; a second launch fails with "A copy of Camoufox is already open".
const open = new Map();

async function assertPinnedInstall() {
  const { INSTALL_DIR } = await import("camoufox-js/dist/pkgman.js");
  const file = path.join(INSTALL_DIR.toString(), "version.json");
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* reported below */ }
  // camoufox-js starts a background reinstall (and cache wipe) when it judges the install unsupported, so refuse to launch on anything but the known-good build.
  if (!installed || installed.version !== CAMOUFOX_PIN.version || installed.release !== CAMOUFOX_PIN.release) {
    throw new Error(`Camoufox ${CAMOUFOX_PIN.version}-${CAMOUFOX_PIN.release} is not installed at ${INSTALL_DIR}. Run "npm run camoufox:fetch" in hiredue-desktop-application, then try again.`);
  }
}

async function stableIdentity(profileDir) {
  const file = path.join(profileDir, IDENTITY_FILE);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));

  const os = hostOS();
  const { generateFingerprint } = await import("camoufox-js/dist/fingerprints.js");
  // A tight screen constraint can exhaust the generator's ten attempts, so loosen until it succeeds (same order as the desktop app).
  let fingerprint;
  for (const constraints of [{ operatingSystems: [os], screen: { maxWidth: 1920, maxHeight: 1080 } }, { operatingSystems: [os] }, {}]) {
    try { fingerprint = generateFingerprint(undefined, constraints); break; } catch { /* try looser */ }
  }
  if (!fingerprint) throw new Error("Could not generate a browser fingerprint for this profile");

  let webgl;
  try {
    const { getPossiblePairs } = await import("camoufox-js/dist/webgl/sample.js");
    const top = (await getPossiblePairs())[OS_SHORT[os]]?.[0];
    if (top) webgl = [top.vendor, top.renderer];
  } catch { /* the GPU may vary per launch; the fingerprint is the signal that matters */ }

  const identity = { os, fingerprint, webgl };
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(identity));
  return identity;
}

async function launch(profileDir, { headless }) {
  if (open.has(profileDir)) throw new Error("This account's browser is already open. Wait for the current run or login to finish.");
  await assertPinnedInstall();
  const identity = await stableIdentity(profileDir);
  const { launchOptions } = await import("camoufox-js");
  const options = await launchOptions({
    headless,
    humanize: true,
    os: identity.os,
    fingerprint: identity.fingerprint,
    ...(identity.webgl ? { webgl_config: identity.webgl } : {}),
    block_webrtc: true,
    geoip: false,
    // Without these, background and headless tabs drop to 1fps and the native cursor animation stalls mid-click.
    firefox_user_prefs: { "layout.throttled_frame_rate": 60, "layout.frame_rate": 60, "dom.animations.offscreen-throttling": false },
    timeout: 60_000,
    config: { showcursor: false },
    // Pinning our own fingerprint is the point (see IDENTITY_FILE); this silences camoufox-js's warning against it.
    i_know_what_im_doing: true,
  });
  const context = await firefox.launchPersistentContext(profileDir, { ...options, viewport: { width: 1280, height: 800 } });
  open.set(profileDir, context);
  context.on("close", () => open.delete(profileDir));
  context.setDefaultNavigationTimeout(TIMEOUT.NAVIGATION);
  const page = context.pages()[0] || (await context.newPage());
  return { context, page, close: () => closeProfile(profileDir) };
}

async function closeProfile(profileDir) {
  const context = open.get(profileDir);
  if (!context) return;
  open.delete(profileDir);
  // A hung close would hold the profile lock forever, so give up after 15s.
  await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
}

const isOpen = (profileDir) => open.has(profileDir);
const closeAll = () => Promise.all([...open.keys()].map(closeProfile));

module.exports = { launch, closeProfile, closeAll, isOpen };
