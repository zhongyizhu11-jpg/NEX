import assert from "node:assert/strict";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { ociProvider } from "./oci";
import { createMockContext, rejectsWith, type ExpectedCall, type RecordedRequest } from "./testing";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const TENANCY = "ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq";
const USER = "ocid1.user.oc1..aaaaaaaat5nvwcna5j6aqzjcaty5eqbb6qt2jvpkanghtgdaqedqw3rynjq";
const FP = "20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34";
const CREDS = { tenancyOcid: TENANCY, userOcid: USER, fingerprint: FP, privateKey: PEM };
const COMPARTMENT = "ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa";
const INSTANCE = "ocid1.instance.oc1.ap-tokyo-1.anxhiljrexampleinstance";
const TARGET = { region: "ap-tokyo-1", compartmentId: COMPARTMENT, instanceId: INSTANCE };
const BASE = "https://iaas.ap-tokyo-1.oraclecloud.com/20160918";
const VNIC = "ocid1.vnic.oc1.ap-tokyo-1.abxhiljrvnic";
const PRIV = "ocid1.privateip.oc1.ap-tokyo-1.abxhiljrpriv";

function verifySignature(req: RecordedRequest) {
  const auth = req.headers.authorization;
  const match = /^Signature version="1",keyId="([^"]+)",algorithm="rsa-sha256",headers="([^"]+)",signature="([^"]+)"$/.exec(auth);
  assert.ok(match, `Authorization 格式不对：${auth}`);
  assert.equal(match[1], `${TENANCY}/${USER}/${FP}`);
  const names = match[2].split(" ");
  const target = `${req.method.toLowerCase()} ${req.url.pathname}${req.url.search}`;
  const lengths: Record<string, string> = { "content-length": String(Buffer.byteLength(req.body)), host: req.url.host };
  const signingString = names.map((name) => (name === "(request-target)" ? `(request-target): ${target}` : `${name}: ${req.headers[name] ?? lengths[name]}`)).join("\n");
  const ok = createVerify("RSA-SHA256").update(signingString).verify(createPublicKey(privateKey), Buffer.from(match[3], "base64"));
  assert.ok(ok, "签名验证失败");
  if (req.body) {
    assert.deepEqual(names, ["date", "(request-target)", "host", "content-length", "content-type", "x-content-sha256"]);
    assert.equal(req.headers["content-type"], "application/json");
  } else {
    assert.deepEqual(names, ["date", "(request-target)", "host"]);
  }
  assert.equal(req.headers.date, "Thu, 15 Oct 2026 08:00:00 GMT");
}

function call(method: string, url: string | ((u: URL) => boolean), json: unknown, check?: (body: any) => void, status = 200): ExpectedCall {
  return {
    method,
    url,
    status,
    json,
    check: (req) => {
      verifySignature(req);
      check?.(req.json);
    },
  };
}

const publicIp = (id: string, ip: string | null, lifetime: string, state: string) => ({
  id,
  ipAddress: ip,
  lifetime,
  lifecycleState: state,
  compartmentId: COMPARTMENT,
  assignedEntityId: state === "ASSIGNED" ? PRIV : null,
  assignedEntityType: "PRIVATE_IP",
  scope: "REGION",
  displayName: "publicip",
});
const locateCalls = (pub: unknown, status = 200): ExpectedCall[] => [
  call(
    "GET",
    (url) => url.pathname === "/20160918/vnicAttachments" && url.searchParams.get("compartmentId") === COMPARTMENT && url.searchParams.get("instanceId") === INSTANCE,
    [{ id: "ocid1.vnicattachment.oc1..x", vnicId: VNIC, instanceId: INSTANCE, lifecycleState: "ATTACHED", nicIndex: 0 }],
  ),
  call("GET", `${BASE}/vnics/${VNIC}`, { id: VNIC, isPrimary: true, compartmentId: COMPARTMENT, privateIp: "10.0.0.2", publicIp: "140.238.1.1", lifecycleState: "AVAILABLE" }),
  call("GET", `${BASE}/privateIps?vnicId=${encodeURIComponent(VNIC)}`, [{ id: PRIV, isPrimary: true, ipAddress: "10.0.0.2", vnicId: VNIC, compartmentId: COMPARTMENT }]),
  call("POST", `${BASE}/publicIps/actions/getByPrivateIpId`, pub, (body) => assert.deepEqual(body, { privateIpId: PRIV }), status),
];

test("OCI：删除临时公网 IP，创建新的并等到 ASSIGNED", async () => {
  const mock = createMockContext([
    ...locateCalls(publicIp("ocid1.publicip.oc1.ap-tokyo-1.old", "140.238.1.1", "EPHEMERAL", "ASSIGNED")),
    { method: "DELETE", url: `${BASE}/publicIps/ocid1.publicip.oc1.ap-tokyo-1.old`, status: 204, check: verifySignature },
    call("GET", `${BASE}/publicIps/ocid1.publicip.oc1.ap-tokyo-1.old`, publicIp("ocid1.publicip.oc1.ap-tokyo-1.old", "140.238.1.1", "EPHEMERAL", "TERMINATING")),
    call("GET", `${BASE}/publicIps/ocid1.publicip.oc1.ap-tokyo-1.old`, { code: "NotAuthorizedOrNotFound", message: "Authorization failed or requested resource not found." }, undefined, 404),
    call("POST", `${BASE}/publicIps`, publicIp("ocid1.publicip.oc1.ap-tokyo-1.new", null, "EPHEMERAL", "ASSIGNING"), (body) => {
      assert.equal(body.compartmentId, COMPARTMENT);
      assert.equal(body.lifetime, "EPHEMERAL");
      assert.equal(body.privateIpId, PRIV);
    }),
    call("GET", `${BASE}/publicIps/ocid1.publicip.oc1.ap-tokyo-1.new`, publicIp("ocid1.publicip.oc1.ap-tokyo-1.new", "152.69.2.2", "EPHEMERAL", "ASSIGNED")),
  ]);
  const result = await ociProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: false });
  mock.assertDone();
  assert.deepEqual([result.oldIp, result.newIp, result.releasedOldIp], ["140.238.1.1", "152.69.2.2", true]);
});

test("OCI：预留公网 IP 卸下、创建失败时挂回去", async () => {
  const mock = createMockContext([
    ...locateCalls(publicIp("ocid1.publicip.oc1.ap-tokyo-1.res", "140.238.1.1", "RESERVED", "ASSIGNED")),
    call("PUT", `${BASE}/publicIps/ocid1.publicip.oc1.ap-tokyo-1.res`, publicIp("ocid1.publicip.oc1.ap-tokyo-1.res", "140.238.1.1", "RESERVED", "UNASSIGNING"), (body) =>
      assert.deepEqual(body, { privateIpId: "" }),
    ),
    call("GET", `${BASE}/publicIps/ocid1.publicip.oc1.ap-tokyo-1.res`, publicIp("ocid1.publicip.oc1.ap-tokyo-1.res", "140.238.1.1", "RESERVED", "AVAILABLE")),
    call("POST", `${BASE}/publicIps`, { code: "LimitExceeded", message: "The limit for public IPs has been exceeded" }, undefined, 400),
    call("PUT", `${BASE}/publicIps/ocid1.publicip.oc1.ap-tokyo-1.res`, publicIp("ocid1.publicip.oc1.ap-tokyo-1.res", "140.238.1.1", "RESERVED", "ASSIGNING"), (body) =>
      assert.deepEqual(body, { privateIpId: PRIV }),
    ),
  ]);
  await rejectsWith(ociProvider.changeIp(CREDS, TARGET, mock.ctx, { releaseOldIp: true }), /LimitExceeded.*已把原预留公网 IP 140\.238\.1\.1 挂回实例/);
  mock.assertDone();
});

test("OCI：没有公网 IP 时 getByPrivateIpId 404 → null；401 映射；私钥格式", async () => {
  const mock = createMockContext([
    ...locateCalls({ code: "NotAuthorizedOrNotFound", message: "not found" }, 404).map((c, i) => (i === 1 ? { ...c, json: { id: VNIC, isPrimary: true, compartmentId: COMPARTMENT } } : c)),
    call("GET", () => true, { code: "NotAuthenticated", message: "The required information to complete authentication was not provided or was incorrect." }, undefined, 401),
  ]);
  assert.equal(await ociProvider.getCurrentIp(CREDS, TARGET, mock.ctx), null);
  await rejectsWith(ociProvider.testCredentials(CREDS, TARGET, mock.ctx), /API 签名密钥无效/);
  const bad = await rejectsWith(ociProvider.getCurrentIp({ ...CREDS, privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, TARGET, mock.ctx), /私钥无法解析/);
  assert.ok(!bad.message.includes("nope"));
  mock.assertDone();
});
