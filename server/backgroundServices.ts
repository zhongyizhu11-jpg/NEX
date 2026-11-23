import { startScheduler } from "./scheduler";
import { startTelegramBot } from "./telegram/telegramBot";
import { isDevPanelMode } from "./devPanelMode";
import { onPanelBackgroundLeaseChange, startPanelBackgroundLease, stopPanelBackgroundLease } from "./panelLease";
import { startPanelWorkPoller } from "./panelWorkRequests";
import { startAgentPresenceElsewhere } from "./agentPresenceElsewhere";
import { addShutdownTask } from "./dbWriteBatcher";
import { noteForwardGroupDatabaseRecovered, runForwardGroupFailoverSweep } from "./forwardGroups/evaluateDriver";
import { startAgentAssetPrefetchLoop } from "./agentAssets";

let backgroundServicesStarted = false;

/*
  后台任务租约（server/panelLease.ts）先续上第一轮再起调度器：这样启动时的那几件「只由持有者做」的事
  （把库里过期的主机标离线等）一开始就知道本实例是不是持有者。续不上（库刚好连不上）也照样起调度器，
  租约每 10 秒再试，任务按当时的持有状态跑或跳过。
*/
function startLeaseThenScheduler() {
  let initial = true;
  onPanelBackgroundLeaseChange((holder) => {
    if (!holder || initial) return;
    // 中途接手（上一任停了）：上一任内存里的存活状态带不过来，给转发组一段就绪宽限，再补一轮巡检。
    noteForwardGroupDatabaseRecovered();
    void runForwardGroupFailoverSweep({ deferPublish: true }).catch((error) => {
      console.warn(`[PanelLease] takeover forward-group sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  addShutdownTask(() => stopPanelBackgroundLease({ release: true }));
  startAgentPresenceElsewhere();
  return startPanelBackgroundLease()
    .catch((error) => {
      console.warn(`[PanelLease] first renew failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      initial = false;
      startPanelWorkPoller();
      startScheduler();
    });
}

export function startBackgroundServices() {
  if (backgroundServicesStarted) return false;
  if (isDevPanelMode()) {
    backgroundServicesStarted = true;
    console.info("[DevPanel] Background scheduler and Telegram bot are disabled in local development panel mode");
    return true;
  }
  backgroundServicesStarted = true;
  void startLeaseThenScheduler();
  // 发布包里没带的 Agent 二进制（gost 运行时、mita）先在后台取好，主机装的时候不用等。
  startAgentAssetPrefetchLoop();
  startTelegramBot().catch((error) => {
    console.warn(`[Telegram] Failed to start bot: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}
