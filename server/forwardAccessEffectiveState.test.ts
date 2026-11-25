import test from "node:test";
import { runInDatabase } from "./testing/runInDatabase";

/**
 * 拨「转发」开关时，面板报的必须是**真的落成了什么**。
 *
 * 原来这条链是这样的：服务端写下管理员的意图（manualCanAddRules），随后重算生效值
 * —— 用户超额时生效值仍然是**关**。可接口返回的是写死的 `{ success: true }`，客户端
 * `onSuccess` 里拿**自己刚发出去的那个值**去 patch 缓存并弹「用户转发已开启」。
 *
 * 于是真面板上就是：toast 说已开启，开关还是灰的，下次刷新原样。管理员以为开好了，
 * 租户那边其实一条转发都跑不起来 —— 而他会来问你为什么。
 *
 * 这条用例盯的是命令层交出来的那个**生效值**：界面上所有的话都得由它来说。
 */
test("开启转发时要交出真正的生效状态，不是请求的那个值", () => {
  runInDatabase(String.raw`
    const cmd = await import(url("server/services/userCommandService.ts"));
    const userRepo = await import(url("server/repositories/userRepository.ts"));

    const GB = 1024 ** 3;

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    /*
      额度读的是 manual 那几列，不是 trafficLimit —— 只设后者的话超额判定根本不触发，
      这个坑我自己踩过一次：第一版复现里三个用户全都「开启成功」，看上去无事发生。
    */
    await exec("INSERT INTO users (id, username, password, role, trafficLimit, manualTrafficLimit, trafficUsed, canAddRules, manualCanAddRules, accountEnabled) VALUES (2, '超额的', 'h', 'user', ?, ?, ?, 0, 0, 1)", [80 * GB, 80 * GB, 82 * GB]);
    await exec("INSERT INTO users (id, username, password, role, trafficLimit, manualTrafficLimit, trafficUsed, canAddRules, manualCanAddRules, accountEnabled) VALUES (3, '正常的', 'h', 'user', ?, ?, 0, 0, 0, 1)", [100 * GB, 100 * GB]);

    const actor = { id: 1, role: "admin" };

    // 正常用户：请求开启 = 真的开起来了
    const ok = await cmd.setUserForwardAccessCommand({ actor, targetUserId: 3, enabled: true });
    assert.equal(ok.canAddRules, true, "正常用户开得起来");
    assert.equal(ok.pauseReason, null);
    assert.equal(Number((await userRepo.getUserById(3)).canAddRules), 1, "库里也真的是开的");

    /*
      超额用户：管理员的意图记下了（manualCanAddRules=true），但生效值仍然是关。
      命令必须把这件事说出来，否则界面只能照着请求值编一句「已开启」。
    */
    const blocked = await cmd.setUserForwardAccessCommand({ actor, targetUserId: 2, enabled: true });
    assert.equal(
      blocked.canAddRules,
      false,
      "超额时开不起来 —— 交出请求值 true 的话，面板就会说一句它没做到的话",
    );
    assert.equal(blocked.pauseReason, "traffic_limit", "还要说清为什么，不然管理员不知道下一步做什么");
    const row = await userRepo.getUserById(2);
    assert.equal(Number(row.canAddRules), 0, "库里确实还是关的");
    assert.equal(Number(row.manualCanAddRules), 1, "但管理员的意图要留着：额度一放开就该自动生效");

    // 关闭这条路上不该有意外：请求关 = 关。
    const off = await cmd.setUserForwardAccessCommand({ actor, targetUserId: 3, enabled: false });
    assert.equal(off.canAddRules, false);
    assert.equal(off.pauseReason, "manual", "是人手动关的，要和「超额被拦」分得开");

    console.log("FORWARD_ACCESS_OK");
  `, { name: "forward-access", env: { NODE_ENV: "test" } });
});
