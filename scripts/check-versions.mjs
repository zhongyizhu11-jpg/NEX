import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const pkg = JSON.parse(read("package.json"));
const versionsTs = read("shared/versions.ts");
const agentMain = read("agent/main.go");
const fxpMain = read("forwardx-fxp/main.go");
const agentFxpVersion = read("agent/fxp_version.go");
const sharedFxpRuntime = read("shared/fxpRuntime.ts");
const sharedSsEgress = read("shared/ssEgress.ts");
const agentGostRuntime = read("agent/gost_runtime_version.go");
const gostRuntimeBuild = read("gost-runtime/build.sh");

const findTsConst = (name) => {
  const match = versionsTs.match(new RegExp(`export const ${name}\\s*=\\s*["']([^"']+)["']`));
  if (!match) throw new Error(`${name} not found in shared/versions.ts`);
  return match[1];
};

const appVersion = findTsConst("APP_VERSION");
const androidAppVersion = findTsConst("ANDROID_APP_VERSION");
const androidApkReleaseVersion = findTsConst("ANDROID_APK_RELEASE_VERSION");
const agentVersion = findTsConst("AGENT_VERSION");
const sharedFxpRuntimeVersion = findTsConst("FXP_RUNTIME_VERSION");
const sharedFxpMinWireVersion = findTsConst("FXP_MIN_WIRE_VERSION");
const agentMinWireFxpVersion = agentFxpVersion.match(/minWireCompatibleFXPVersion\s*=\s*"([^"]+)"/)?.[1];
const agentHandshakeV3Marker = agentFxpVersion.match(/fxpHandshakeV3Marker\s*=\s*"([^"]+)"/)?.[1];
const sharedHandshakeV3Marker = sharedFxpRuntime.match(/FXP_HANDSHAKE_V3_MARKER\s*=\s*"([^"]+)"/)?.[1];
const agentMainVersion = agentMain.match(/var Version\s*=\s*"([^"]+)"/)?.[1];
const fxpRuntimeVersion = fxpMain.match(/fxpRuntimeVersion\s*=\s*"([^"]+)"/)?.[1];

const semverPattern = /^\d+\.\d+\.\d+$/;

const releaseTag = (
  process.env.FORWARDX_RELEASE_TAG
  || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "")
  || (process.env.GITHUB_REF?.startsWith("refs/tags/") ? process.env.GITHUB_REF.slice("refs/tags/".length) : "")
  || ""
).trim();

const errors = [];
if (pkg.version !== appVersion) {
  errors.push(`package.json version ${pkg.version} does not match APP_VERSION ${appVersion}`);
}
if (androidApkReleaseVersion !== appVersion) {
  errors.push(`ANDROID_APK_RELEASE_VERSION ${androidApkReleaseVersion} does not match APP_VERSION ${appVersion}`);
}
if (agentMainVersion !== agentVersion) {
  errors.push(`agent/main.go Version ${agentMainVersion || "(missing)"} does not match AGENT_VERSION ${agentVersion}`);
}
if (!fxpRuntimeVersion) {
  errors.push("fxpRuntimeVersion not found in forwardx-fxp/main.go");
} else if (!semverPattern.test(fxpRuntimeVersion)) {
  errors.push(`FXP runtime version ${fxpRuntimeVersion} must use x.y.z format`);
}
if (fxpRuntimeVersion && sharedFxpRuntimeVersion !== fxpRuntimeVersion) {
  errors.push(`shared/versions.ts FXP_RUNTIME_VERSION ${sharedFxpRuntimeVersion} does not match forwardx-fxp/main.go ${fxpRuntimeVersion}`);
}
if (agentMinWireFxpVersion !== sharedFxpMinWireVersion) {
  errors.push(`agent/fxp_version.go minWireCompatibleFXPVersion ${agentMinWireFxpVersion || "(missing)"} does not match FXP_MIN_WIRE_VERSION ${sharedFxpMinWireVersion}`);
}
// 不认识 -version 的旧 FXP 靠这条握手 v3 的文案区分能不能握手（Agent 和安装脚本各用一份）。
if (!sharedHandshakeV3Marker || agentHandshakeV3Marker !== sharedHandshakeV3Marker) {
  errors.push(`agent/fxp_version.go fxpHandshakeV3Marker does not match shared/fxpRuntime.ts FXP_HANDSHAKE_V3_MARKER`);
} else if (!fxpMain.includes(sharedHandshakeV3Marker)) {
  errors.push(`forwardx-fxp/main.go no longer contains the handshake v3 marker "${sharedHandshakeV3Marker}"; legacy FXP detection relies on it`);
}
// Shadowsocks 出口的 UDP / SS2022 能力：Agent 报、面板认，两边的门槛和名字必须是同一份；
// 自编运行时的默认构建号不能低于面板要求的构建号（否则发布出去的运行时撑不起能力）。
const tsString = (source, name) => source.match(new RegExp(`export const ${name}\\s*=\\s*["']([^"']+)["']`))?.[1];
const tsNumber = (source, name) => source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`))?.[1];
const goConst = (name) => agentGostRuntime.match(new RegExp(`${name}\\s*=\\s*"?([^"\\s]+)"?`))?.[1];
for (const [goName, tsName, tsValue] of [
  ["ssEgressCapabilityAgentVersion", "SS_EGRESS_CAPABILITY_AGENT_VERSION", tsString(sharedSsEgress, "SS_EGRESS_CAPABILITY_AGENT_VERSION")],
  ["ssEgressRuntimeMinNexBuild", "SS_EGRESS_RUNTIME_MIN_NEX_BUILD", tsNumber(sharedSsEgress, "SS_EGRESS_RUNTIME_MIN_NEX_BUILD")],
  ["agentCapabilitySsEgressUDP", "AGENT_CAPABILITY_SS_EGRESS_UDP", tsString(sharedSsEgress, "AGENT_CAPABILITY_SS_EGRESS_UDP")],
  ["agentCapabilitySsEgress2022", "AGENT_CAPABILITY_SS_EGRESS_2022", tsString(sharedSsEgress, "AGENT_CAPABILITY_SS_EGRESS_2022")],
]) {
  const goValue = goConst(goName);
  if (!tsValue || goValue !== tsValue) errors.push(`agent/gost_runtime_version.go ${goName} ${goValue || "(missing)"} does not match shared/ssEgress.ts ${tsName} ${tsValue || "(missing)"}`);
}
const minNexBuild = Number(tsNumber(sharedSsEgress, "SS_EGRESS_RUNTIME_MIN_NEX_BUILD") || 0);
const defaultNexBuild = Number(gostRuntimeBuild.match(/NEX_GOST_BUILD="\$\{NEX_GOST_BUILD:-nex(\d+)\}"/)?.[1] || 0);
if (!defaultNexBuild || defaultNexBuild < minNexBuild) {
  errors.push(`gost-runtime/build.sh NEX_GOST_BUILD default nex${defaultNexBuild || "?"} is below SS_EGRESS_RUNTIME_MIN_NEX_BUILD ${minNexBuild}`);
}
// 装机脚本按 NEX_GOST_RUNTIME_BUILD 决定要不要换运行时：必须就是这一版编出来的构建号。
const targetNexBuild = Number(tsNumber(sharedSsEgress, "NEX_GOST_RUNTIME_BUILD") || 0);
if (targetNexBuild !== defaultNexBuild) {
  errors.push(`shared/ssEgress.ts NEX_GOST_RUNTIME_BUILD ${targetNexBuild || "(missing)"} does not match gost-runtime/build.sh NEX_GOST_BUILD default nex${defaultNexBuild || "?"}`);
}
const capabilityAgentVersion = tsString(sharedSsEgress, "SS_EGRESS_CAPABILITY_AGENT_VERSION");
if (capabilityAgentVersion && agentVersion.split(".").map(Number).reduce((acc, part, index) => acc || (part - (capabilityAgentVersion.split(".").map(Number)[index] || 0)), 0) < 0) {
  errors.push(`AGENT_VERSION ${agentVersion} is older than SS_EGRESS_CAPABILITY_AGENT_VERSION ${capabilityAgentVersion}`);
}
if (appVersion === agentVersion) {
  errors.push(`APP_VERSION and AGENT_VERSION are both ${appVersion}; keep panel and Agent version lines separate`);
}
for (const [name, version] of [
  ["APP_VERSION", appVersion],
  ["ANDROID_APP_VERSION", androidAppVersion],
  ["ANDROID_APK_RELEASE_VERSION", androidApkReleaseVersion],
  ["AGENT_VERSION", agentVersion],
  ["FXP_RUNTIME_VERSION", sharedFxpRuntimeVersion],
  ["FXP_MIN_WIRE_VERSION", sharedFxpMinWireVersion],
]) {
  if (!semverPattern.test(version)) errors.push(`${name} ${version} must use x.y.z format`);
}
if (releaseTag && releaseTag !== `v${appVersion}`) {
  errors.push(`release tag ${releaseTag} does not match APP_VERSION v${appVersion}`);
}
if (errors.length) {
  console.error(errors.map((line) => `- ${line}`).join("\n"));
  process.exit(1);
}

console.log(`versions ok: panel=${appVersion} android=${androidAppVersion} apkRelease=${androidApkReleaseVersion} agent=${agentVersion} fxp=${fxpRuntimeVersion}${releaseTag ? ` tag=${releaseTag}` : ""}`);
