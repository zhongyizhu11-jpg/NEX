/*
  「申请新 EIP → 解绑旧 EIP → 绑定新 EIP → 释放旧 EIP」的通用编排（阿里云 / 腾讯云 / 华为云 / 火山引擎共用）。

  失败处理：
  - 申请时结果未知（ambiguous）：提示去控制台检查是否多出一个闲置 EIP。
  - 解绑 / 绑定明确失败：把旧 EIP 绑回去（如果已经解绑），再释放新 EIP，避免闲置计费。
  - 绑定结果未知：不释放新 EIP（可能已经绑上），提示人工确认。
  - 旧 EIP 只在 releaseOldIp 且它确实是在这台实例上找到的情况下才释放；释放失败只记 note，不让整次换 IP 失败。
*/
import { appendToError, bestEffort } from "./common";
import { IpChangeProviderError, type IpChangeContext, type IpChangeResult } from "./types";

export type EipRef = { id: string; ip: string };

export type EipSwapOps = {
  label: string;
  /** 申请新 EIP，并等到可绑定（返回已校验的 IP） */
  allocate(): Promise<EipRef>;
  /** 解绑并等到解绑完成 */
  disassociate(eip: EipRef): Promise<void>;
  /** 绑定并等到绑定完成 */
  associate(eip: EipRef): Promise<void>;
  release(eip: EipRef): Promise<void>;
  /** 可选：绑定完成后再从实例侧确认一次公网 IP */
  verify?(newIp: string): Promise<void>;
};

export async function runEipSwap(
  ctx: IpChangeContext,
  ops: EipSwapOps,
  input: { oldEip: EipRef | null; oldIp: string | null; releaseOldIp: boolean; notes?: string[] },
): Promise<IpChangeResult> {
  const notes = [...(input.notes || [])];
  let created: EipRef;
  try {
    created = await ops.allocate();
  } catch (error) {
    if (error instanceof IpChangeProviderError && error.options.ambiguous) {
      throw appendToError(error, "可能已经申请了一个新的 EIP，请到控制台检查，闲置的请手动释放");
    }
    throw error;
  }
  ctx.log(`${ops.label}：已申请新 EIP ${created.ip}（${created.id}）`);

  const releaseNew = () => bestEffort(ctx, `${ops.label}：释放新申请的 EIP ${created.ip}`, () => ops.release(created));

  let detached = false;
  try {
    if (input.oldEip) {
      await ops.disassociate(input.oldEip);
      detached = true;
      ctx.log(`${ops.label}：已解绑旧 EIP ${input.oldEip.ip}`);
    }
  } catch (error) {
    const released = await releaseNew();
    const tail = released ? `已释放新申请的 EIP ${created.ip}` : `新申请的 EIP ${created.ip}（${created.id}）释放失败，请到控制台手动释放以免继续计费`;
    const ambiguous = error instanceof IpChangeProviderError && error.options.ambiguous;
    throw appendToError(error, ambiguous ? `旧 EIP ${input.oldEip?.ip} 是否已解绑未知，请到控制台确认；${tail}` : tail);
  }

  try {
    await ops.associate(created);
  } catch (error) {
    if (error instanceof IpChangeProviderError && error.options.ambiguous) {
      throw appendToError(error, `新 EIP ${created.ip}（${created.id}）的绑定结果未知，请到控制台确认；如未绑定请手动释放${detached ? `，并把旧 EIP ${input.oldEip?.ip} 绑回去` : ""}`);
    }
    const parts: string[] = [];
    if (detached && input.oldEip) {
      const oldEip = input.oldEip;
      const ok = await bestEffort(ctx, `${ops.label}：把旧 EIP ${oldEip.ip} 绑回去`, () => ops.associate(oldEip));
      parts.push(ok ? `已把旧 EIP ${oldEip.ip} 绑回实例` : `旧 EIP ${oldEip.ip} 绑回失败，请到控制台处理`);
    }
    const released = await releaseNew();
    parts.push(released ? `已释放新申请的 EIP ${created.ip}` : `新申请的 EIP ${created.ip}（${created.id}）释放失败，请到控制台手动释放以免继续计费`);
    throw appendToError(error, parts.join("；"));
  }
  ctx.log(`${ops.label}：新 EIP ${created.ip} 已绑定`);

  if (ops.verify) await ops.verify(created.ip);

  let releasedOldIp = false;
  if (input.oldEip) {
    if (input.releaseOldIp) {
      try {
        await ops.release(input.oldEip);
        releasedOldIp = true;
        notes.push(`已释放旧 EIP ${input.oldEip.ip}`);
      } catch (error) {
        notes.push(`旧 EIP ${input.oldEip.ip}（${input.oldEip.id}）释放失败，请到控制台手动释放：${(error as Error).message}`);
      }
    } else {
      notes.push(`旧 EIP ${input.oldEip.ip}（${input.oldEip.id}）已解绑但仍保留在账号里，闲置 EIP 可能计费`);
    }
  }
  notes.push(`新 IP ${created.ip} 是弹性公网 IP（${created.id}）`);
  return { oldIp: input.oldIp, newIp: created.ip, ipRole: "primary", releasedOldIp, notes };
}
