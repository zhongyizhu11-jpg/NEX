import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { DNSPOD_MAX_CHANGES_PER_SAVE, DNSPOD_MAX_RECORD_TTL, DNSPOD_MIN_RECORD_TTL, DNSPOD_WRITABLE_RECORD_TYPES } from "@shared/dnspodRecords";
import {
  applyDnspodRecordChanges,
  dnspodDefaultDomain,
  DnspodRecordsError,
  listDnspodDomains,
  listDnspodRecordLines,
  listDnspodRecords,
} from "../dnspodRecords";

/*
  trpc.dnsRecords.* —— 系统设置里的「DNSPod 解析记录」：选域名、按完整子域名看记录、暂存后统一保存。
  只给管理员；API 令牌归「系统设置」模块（shared/apiTokenModules.ts）。实现和保护规则见 server/dnspodRecords.ts。
*/

function toTrpcError(error: unknown): never {
  if (error instanceof DnspodRecordsError) {
    const code = error.code === "NOT_CONFIGURED"
      ? "PRECONDITION_FAILED"
      : error.code === "MANAGED"
        ? "FORBIDDEN"
        : error.code === "CHANGED"
          ? "CONFLICT"
          : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  throw error;
}

const domainInput = z.object({ domain: z.string().trim().min(1).max(253) });

const draftInput = z.object({
  subdomain: z.string().trim().min(1).max(253),
  type: z.enum(DNSPOD_WRITABLE_RECORD_TYPES),
  lineId: z.string().trim().min(1).max(64),
  lineName: z.string().trim().max(64).optional(),
  value: z.string().trim().min(1).max(2048),
  ttl: z.number().int().min(DNSPOD_MIN_RECORD_TTL).max(DNSPOD_MAX_RECORD_TTL),
});

const changeKey = z.string().trim().min(1).max(64);
const recordId = z.string().trim().regex(/^\d{1,20}$/);
const revision = z.string().trim().min(1).max(128);

const changeInput = z.discriminatedUnion("kind", [
  z.object({ key: changeKey, kind: z.literal("create"), record: draftInput }),
  z.object({ key: changeKey, kind: z.literal("update"), recordId, revision, record: draftInput }),
  z.object({ key: changeKey, kind: z.literal("delete"), recordId, revision }),
]);

export const dnsRecordsRouter = router({
  /**
   * 账号下的域名。没填凭据时不报错，返回 configured=false 和原因，页面据此提示去填；
   * 其余失败（网络、服务商拒绝、响应异常）照常报错 —— 页面显示错误，不显示成「没有域名」。
   */
  domains: adminProcedure.query(async () => {
    const defaultDomain = await dnspodDefaultDomain();
    try {
      return { configured: true as const, reason: null, defaultDomain, domains: await listDnspodDomains() };
    } catch (error) {
      if (error instanceof DnspodRecordsError && error.code === "NOT_CONFIGURED") {
        return { configured: false as const, reason: error.message, defaultDomain, domains: [] };
      }
      return toTrpcError(error);
    }
  }),

  /** 这个域名的套餐能选哪些线路（默认 / 电信 / 联通 / 移动 / 境外 / 教育网……）。 */
  lines: adminProcedure.input(domainInput).query(async ({ input }) => {
    try {
      return { lines: await listDnspodRecordLines(input.domain) };
    } catch (error) {
      return toTrpcError(error);
    }
  }),

  /** 一个域名下的全部记录（翻完所有页），按完整子域名分组，面板管着的标只读。 */
  records: adminProcedure.input(domainInput).query(async ({ input }) => {
    try {
      return await listDnspodRecords(input.domain);
    } catch (error) {
      return toTrpcError(error);
    }
  }),

  /** 统一保存暂存的变更。逐条返回结果：done 的浏览器从暂存区拿掉，其余留着。 */
  applyChanges: adminProcedure
    .input(domainInput.extend({ changes: z.array(changeInput).min(1).max(DNSPOD_MAX_CHANGES_PER_SAVE) }))
    .mutation(async ({ input }) => {
      try {
        return await applyDnspodRecordChanges(input.domain, input.changes);
      } catch (error) {
        return toTrpcError(error);
      }
    }),
});
