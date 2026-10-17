import type { User } from "../drizzle/schema";
import { getUserById } from "./repositories/userRepository";

/**
 * 管理员在规则页选中某个用户之后新建 / 复制 / 导入规则：规则归那个用户。
 *
 * 不是「以管理员身份替他建」—— 返回的是那个用户本人，后面的检查（主机 / 隧道 / 转发组的使用
 * 权限、套餐端口段、规则数和端口数配额、转发权限、余额）全部按他来，管理员不能借此给他建出
 * 他自己建不了的规则。端口提示（entryPortPolicy）、端口检查、随机端口用同一个函数，界面上
 * 看到的范围和保存时的判定是同一份。
 */
export async function resolveRuleOperationOwner<T extends { id: number; role: string }>(actor: T, requestedUserId?: number | null): Promise<T | User> {
  if (requestedUserId === undefined || requestedUserId === null || Number(requestedUserId) === Number(actor.id)) return actor;
  if (actor.role !== "admin") throw new Error("无权操作其他用户的规则");
  const owner = await getUserById(Number(requestedUserId));
  if (!owner) throw new Error("所选用户不存在");
  if ((owner as any).accountEnabled === false || (owner as any).accountEnabled === 0) throw new Error("所选用户已被禁用");
  return owner;
}
