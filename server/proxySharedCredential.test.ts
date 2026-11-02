import test from "node:test";
import { runInDatabase as runSharedDatabaseTest } from "./testing/runInDatabase";

/**
 * 分享给租户时发一份独立凭据。
 *
 * 这一组守的是那句承诺：**取消分享之后，那个人真的连不上，而别人照旧**。
 * 光删一条分享记录做不到这件事 —— 凭据还在端口上活着，他把订阅存下来照样能
 * 用。所以分享必须落到「在那个入站上给他单独开一份」，取消时把那份删掉。
 *
 * 另一半是它不能被顺手删掉：管理员在入站弹窗里改个名字保存一下，提交的用户
 * 清单里没有这些自动发的凭据，全量替换会把租户集体断掉，而界面上看不出来。
 */
const setup = String.raw`
    const shares = await import(url("server/repositories/proxySubscriptionRepository.ts"));
    const inbounds = await import(url("server/repositories/proxyInboundRepository.ts"));


    // alice 是落地机与入站的主人；bob、carol 是租户。
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (1, 'alice', 'hash', 'admin', 1)");
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (2, 'bob', 'hash', 'user', 1)");
    await exec("INSERT INTO users (id, username, password, role, allowProxySubscription) VALUES (3, 'carol', 'hash', 'user', 1)");
    await exec("INSERT INTO hosts (id, name, ip, agentToken, userId) VALUES (10, 'hk', '203.0.113.9', 'tok', 1)");

    /** 建一个入站并派生节点，返回主人自己那条节点的 id。 */
    const makeInbound = async (protocol, port) => {
      const id = Number(await inbounds.createProxyInbound({
        userId: 1, hostId: 10, name: "HK", protocol, port,
        transport: "tcp", security: protocol === "vless" ? "reality" : "none",
        uuid: "11111111-2222-3333-4444-555555555555",
        password: "psk-of-the-owner", method: "aes-128-gcm",
        isEnabled: true,
      }));
      await inbounds.replaceProxyInboundUsers(id, [
        { id: 0, name: "自己", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", password: "own-pass" },
      ]);
      await inbounds.syncProxyNodeFromInbound(id);
      const rows = await query("SELECT id FROM proxy_nodes WHERE inboundId = ? ORDER BY id", [id]);
      return { inboundId: id, nodeId: Number(rows[0].id) };
    };
`;

function runInDatabase(body: string) {
  runSharedDatabaseTest(body, { name: "shared-credential", setup });
}

test("分享多凭据入站：对方拿到的是自己那份，不是主人那份", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });

    const credentials = await inbounds.getProxyInboundUsers(inboundId);
    const forBob = credentials.filter((user) => Number(user.sharedUserId) === 2);
    assert.equal(forBob.length, 1, "应该给 bob 单独开一份凭据");
    assert.notEqual(forBob[0].uuid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "不能把主人那份抄给他");

    const bobNodes = await shares.getProxyNodesSharedToUser(2);
    assert.equal(bobNodes.length, 1);
    assert.equal(Number(bobNodes[0].inboundUserId), Number(forBob[0].id), "分享记的是他自己那条派生节点");
    assert.equal(bobNodes[0].uuid, forBob[0].uuid);
    assert.notEqual(Number(bobNodes[0].id), nodeId, "不该是主人那条");
  `);
});

test("取消分享：他那份凭据真的没了，别人的照旧", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2, 3], { labels: new Map([[2, "bob"], [3, "carol"]]) });
    assert.equal((await inbounds.getProxyInboundUsers(inboundId)).length, 3);

    await shares.setProxyNodeShareUsers(nodeId, [3], { labels: new Map([[3, "carol"]]) });
    const left = await inbounds.getProxyInboundUsers(inboundId);
    assert.equal(left.filter((user) => Number(user.sharedUserId) === 2).length, 0, "bob 那份要删掉");
    assert.equal(left.filter((user) => Number(user.sharedUserId) === 3).length, 1, "carol 的不受影响");

    // 凭据没了，派生节点和分享记录都要跟着走，否则订阅里留下一条连不上的节点。
    assert.equal((await shares.getProxyNodesSharedToUser(2)).length, 0);
    assert.equal((await shares.getProxyNodesSharedToUser(3)).length, 1);
  `);
});

test("再点一次保存不会多发一份凭据", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });
    const first = (await inbounds.getProxyInboundUsers(inboundId)).find((user) => Number(user.sharedUserId) === 2);

    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });
    const after = (await inbounds.getProxyInboundUsers(inboundId)).filter((user) => Number(user.sharedUserId) === 2);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, first.id, "凭据换掉的话对方要重拉订阅，不能白换");

    const rows = await query("SELECT COUNT(*) AS c FROM proxy_node_shares WHERE userId = 2");
    assert.equal(Number(rows[0].c), 1, "分享记录也不该重复");
  `);
});

test("从节点这边看，分享名单里是有他的", () => {
  runInDatabase(String.raw`
    const { nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });
    // 分享落在他自己那条派生节点上，直接查这条节点的分享记录会是空的 ——
    // 界面拿这个结果显示「分享给谁」，返回空就等于告诉管理员没分享出去。
    const recipients = await shares.getProxyNodeShareRecipients(nodeId);
    assert.deepEqual(recipients, [2]);
  `);
});

test("保存入站不会顺手删掉分享发出去的凭据", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });

    // 弹窗提交的清单里只有管理员手工加的那份 —— 自动发的凭据它根本不知道。
    await inbounds.replaceProxyInboundUsers(inboundId, [
      { id: 0, name: "自己", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", password: "own-pass" },
    ]);
    await inbounds.syncProxyNodeFromInbound(inboundId);

    const left = await inbounds.getProxyInboundUsers(inboundId);
    assert.equal(left.filter((user) => Number(user.sharedUserId) === 2).length, 1, "bob 那份要留着");
    assert.equal((await shares.getProxyNodesSharedToUser(2)).length, 1, "他订阅里的节点也要还在");
  `);
});

test("表单不能把凭据的归属改到别人头上", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });
    const forBob = (await inbounds.getProxyInboundUsers(inboundId)).find((user) => Number(user.sharedUserId) === 2);

    // 伪造一次提交：把 bob 那行的 sharedUserId 改成 carol。
    await inbounds.replaceProxyInboundUsers(inboundId, [
      { id: forBob.id, name: "偷来的", uuid: forBob.uuid, password: forBob.password, sharedUserId: 3 },
    ]);
    const after = (await inbounds.getProxyInboundUsers(inboundId)).find((user) => user.id === forBob.id);
    assert.equal(Number(after.sharedUserId), 2, "收件人只能由分享流程决定");
  `);
});

test("单凭据协议（Shadowsocks）走老路：分享的就是同一份", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("shadowsocks", 8388);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });

    // 一个端口只有一份 PSK，硬开多用户会让已经发出去的配置全部失效 ——
    // 那是另一件要人点头的事，不在分享里偷偷做。
    assert.equal((await inbounds.getProxyInboundUsers(inboundId)).filter((u) => Number(u.sharedUserId) > 0).length, 0);
    const bobNodes = await shares.getProxyNodesSharedToUser(2);
    assert.equal(bobNodes.length, 1);
    assert.equal(Number(bobNodes[0].id), nodeId, "拿到的就是主人那条");
  `);
});

test("从用户那边挑节点，同样是发独立凭据；挪走了就收回", () => {
  runInDatabase(String.raw`
    const first = await makeInbound("vless", 443);
    const second = await makeInbound("trojan", 8443);

    await shares.setProxyNodeSharesForUser(2, [first.nodeId], { label: "bob" });
    assert.equal((await inbounds.getProxyInboundUsers(first.inboundId)).filter((u) => Number(u.sharedUserId) === 2).length, 1);

    // 改成只给第二个入站：第一个上的那份凭据要收回，不然他存下来的订阅照样能连。
    await shares.setProxyNodeSharesForUser(2, [second.nodeId], { label: "bob" });
    assert.equal((await inbounds.getProxyInboundUsers(first.inboundId)).filter((u) => Number(u.sharedUserId) === 2).length, 0);
    assert.equal((await inbounds.getProxyInboundUsers(second.inboundId)).filter((u) => Number(u.sharedUserId) === 2).length, 1);

    const bobNodes = await shares.getProxyNodesSharedToUser(2);
    assert.equal(bobNodes.length, 1);
    assert.equal(bobNodes[0].protocol, "trojan");
  `);
});

test("清空分享清单，凭据一起收回", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeSharesForUser(2, [nodeId], { label: "bob" });
    await shares.setProxyNodeSharesForUser(2, [], { label: "bob" });
    assert.equal((await inbounds.getProxyInboundUsers(inboundId)).filter((u) => Number(u.sharedUserId) === 2).length, 0);
    assert.equal((await shares.getProxyNodesSharedToUser(2)).length, 0);
  `);
});

test("别人已经拿到的凭据不会出现在「可分享」清单里", () => {
  runInDatabase(String.raw`
    const { nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });

    const options = await shares.getProxyNodeShareOptions();
    // 主人那条还在（要给第三个人就挑它，系统会另发一份），bob 那条不在。
    assert.ok(options.some((row) => Number(row.id) === nodeId));
    const bobNodeId = Number((await shares.getProxyNodesSharedToUser(2))[0].id);
    assert.ok(!options.some((row) => Number(row.id) === bobNodeId));
  `);
});

test("两个人各拿各的，删一个不影响另一个的凭据", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2, 3], { labels: new Map([[2, "bob"], [3, "carol"]]) });
    const credentials = await inbounds.getProxyInboundUsers(inboundId);
    const bob = credentials.find((user) => Number(user.sharedUserId) === 2);
    const carol = credentials.find((user) => Number(user.sharedUserId) === 3);
    assert.notEqual(bob.uuid, carol.uuid, "两份凭据不能一样，否则吊销一个等于吊销两个");

    await shares.setProxyNodeSharesForUser(2, [], { label: "bob" });
    const carolAfter = (await inbounds.getProxyInboundUsers(inboundId)).find((user) => Number(user.sharedUserId) === 3);
    assert.equal(carolAfter.uuid, carol.uuid, "carol 那份不能被换掉");
  `);
});

test("为别人发的凭据不进主人自己的订阅", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2, 3], { labels: new Map([[2, "bob"], [3, "carol"]]) });

    // 主人的端口上现在有三份凭据，但他自己的订阅里只该有自己那一条 ——
    // 否则每多一个租户，他的客户端里就多一条只有凭据不同的重复线路。
    const ownerNodes = await shares.getProxyNodesForSubscription(1);
    assert.equal(ownerNodes.length, 1);
    assert.equal(Number(ownerNodes[0].id), nodeId);

    // 租户那边照常，各拿各的。
    assert.equal((await shares.getProxyNodesForSubscription(2)).length, 1);
    assert.equal((await shares.getProxyNodesForSubscription(3)).length, 1);
  `);
});

test("到期 / 停用 / 收回订阅权限之后，那份凭据不再进下发配置", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2, 3], { labels: new Map([[2, "bob"], [3, "carol"]]) });

    const namesInConfig = async () => {
      const list = await inbounds.getEnabledProxyInboundsWithUsersByHost(10);
      return list[0].inbound.users.map((user) => Number(user.sharedUserId || 0)).sort();
    };
    assert.deepEqual(await namesInConfig(), [0, 2, 3], "一开始三份凭据都在");

    // 停用账号：面板那边拦住的只是订阅地址，客户端里存下的配置照连不误 ——
    // 得让它从落地机的配置里消失，「停用就断」才是真的。
    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 2");
    assert.deepEqual(await namesInConfig(), [0, 3]);

    await exec("UPDATE users SET accountEnabled = 1 WHERE id = 2");
    assert.deepEqual(await namesInConfig(), [0, 2, 3], "恢复账号就该恢复");

    // 到期
    await exec("UPDATE users SET expiresAt = ? WHERE id = 2", [Math.floor(Date.now() / 1000) - 60]);
    assert.deepEqual(await namesInConfig(), [0, 3]);
    await exec("UPDATE users SET expiresAt = NULL WHERE id = 2");

    // 收回订阅权限
    await exec("UPDATE users SET allowProxySubscription = 0 WHERE id = 2");
    assert.deepEqual(await namesInConfig(), [0, 3]);
  `);
});

test("删掉账号，他手上的凭据一起收回", () => {
  runInDatabase(String.raw`
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2, 3], { labels: new Map([[2, "bob"], [3, "carol"]]) });

    const hostIds = await inbounds.releaseAllSharedCredentialsForUser(2);
    assert.deepEqual(hostIds, [10], "要告诉调用方哪台机器需要重下发");

    const left = await inbounds.getProxyInboundUsers(inboundId);
    assert.equal(left.filter((user) => Number(user.sharedUserId) === 2).length, 0);
    assert.equal(left.filter((user) => Number(user.sharedUserId) === 3).length, 1, "别人的不动");
  `);
});

test("主人自己那份凭据不受收件人状态影响", () => {
  runInDatabase(String.raw`
    const { nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeShareUsers(nodeId, [2], { labels: new Map([[2, "bob"]]) });
    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 2");

    const list = await inbounds.getEnabledProxyInboundsWithUsersByHost(10);
    const own = list[0].inbound.users.filter((user) => !Number(user.sharedUserId || 0));
    assert.equal(own.length, 1, "端口是主人的，不该因为租户被停用而少掉自己那份");
  `);
});

test("主人自己到期 / 被停用，他的端口也从下发配置里消失", () => {
  runInDatabase(String.raw`
    // bob 名下的一个自建入站 —— 套餐给的专属端口也是这个形状。
    const id = Number(await inbounds.createProxyInbound({
      userId: 2, hostId: 10, name: "bob 的端口", protocol: "vless", port: 8443,
      transport: "tcp", security: "reality",
      uuid: "99999999-8888-7777-6666-555555555555", isEnabled: true,
    }));
    await inbounds.replaceProxyInboundUsers(id, [{ id: 0, name: "自己", uuid: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", password: "" }]);
    await inbounds.syncProxyNodeFromInbound(id);

    const ports = async () => (await inbounds.getEnabledProxyInboundsWithUsersByHost(10)).map((row) => row.port).sort();
    assert.deepEqual(await ports(), [8443]);

    // 面板那边拦住的只是页面和订阅地址；端口不从配置里拿掉，他手上那份配置照连。
    await exec("UPDATE users SET accountEnabled = 0 WHERE id = 2");
    assert.deepEqual(await ports(), []);

    await exec("UPDATE users SET accountEnabled = 1 WHERE id = 2");
    assert.deepEqual(await ports(), [8443], "恢复账号就该恢复监听");

    await exec("UPDATE users SET expiresAt = ? WHERE id = 2", [Math.floor(Date.now() / 1000) - 60]);
    assert.deepEqual(await ports(), []);
    await exec("UPDATE users SET expiresAt = NULL WHERE id = 2");

    await exec("UPDATE users SET allowProxySubscription = 0 WHERE id = 2");
    assert.deepEqual(await ports(), []);
  `);
});

test("管理员的端口不受这条影响", () => {
  runInDatabase(String.raw`
    const { inboundId } = await makeInbound("vless", 443);
    // alice 是管理员：她没有「订阅权限」这一说，端口该一直在。
    await exec("UPDATE users SET allowProxySubscription = 0 WHERE id = 1");
    const list = await inbounds.getEnabledProxyInboundsWithUsersByHost(10);
    assert.equal(list.length, 1);
    assert.equal(Number(list[0].id), inboundId);
  `);
});

test("换归属之后，新主人订阅里不会出现两条同一个端口的节点", () => {
  runInDatabase(String.raw`
    // 先把 alice 的端口分给 bob，再把这个端口整个转给 bob。
    const { inboundId, nodeId } = await makeInbound("vless", 443);
    await shares.setProxyNodeSharesForUser(2, [nodeId], { label: "bob" });
    assert.equal((await shares.getProxyNodesForSubscription(2)).length, 1);

    await inbounds.updateProxyInbound(inboundId, { userId: 2 });
    await inbounds.syncProxyNodeFromInbound(inboundId);

    /**
     * 不收掉那份共享凭据的话，bob 的客户端里会出现两条一模一样、只有凭据不同的
     * 线路：一条是端口本身的（现在归他了），一条是当初作为租户分给他的那份。
     * 界面上看不出哪条该留 —— 「自己的节点不用分享」这条规矩在换归属之后漏了。
     */
    const mine = await shares.getProxyNodesForSubscription(2);
    assert.equal(mine.length, 1, "同一个端口只该有一条");
    assert.equal((await shares.getProxyNodeIdsSharedToUser(2)).length, 0, "分享行也要一起清掉");
    // 原主人那边已经没有这个端口了。
    assert.equal((await shares.getProxyNodesForSubscription(1)).length, 0);
  `);
});
