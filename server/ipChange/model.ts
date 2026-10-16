import type { IpChangeCheckMethod, IpChangeEventStatus, IpChangeState, IpChangeTrigger } from "../../shared/ipChange";
import type { IpChangeTarget } from "./providers";

export type IpChangeAccountRecord = {
  id: number;
  name: string;
  provider: string;
  /** 密文，见 ./secrets.ts。 */
  credentialsJson: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type IpChangeConfigRecord = {
  id: number;
  hostId: number;
  enabled: boolean;
  autoEnabled: boolean;
  cloudAccountId: number | null;
  target: IpChangeTarget;
  checkTargets: string;
  checkMethod: IpChangeCheckMethod;
  failureThreshold: number;
  checkIntervalSeconds: number;
  cooldownMinutes: number;
  maxChangesPerDay: number;
  releaseOldIp: boolean;
  state: IpChangeState;
  consecutiveFailures: number;
  lastCheckAt: Date | null;
  lastChangeAt: Date | null;
  lastError: string | null;
  generation: number;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type IpChangeConfigPatch = Partial<Omit<IpChangeConfigRecord, "id" | "hostId" | "createdAt" | "updatedAt">>;

export type IpChangeEventRecord = {
  id: number;
  hostId: number;
  trigger: IpChangeTrigger;
  provider: string | null;
  oldIp: string | null;
  newIp: string | null;
  ipRole: "primary" | "entry" | null;
  status: IpChangeEventStatus;
  error: string | null;
  notes: string[];
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type IpChangeEventInsert = Omit<IpChangeEventRecord, "id">;
export type IpChangeEventPatch = Partial<Omit<IpChangeEventRecord, "id" | "hostId">>;

/** 服务层只认这个接口：线上是 SQL 实现（./repository.ts），测试里是内存实现（./memoryStore.ts）。 */
export interface IpChangeStore {
  listAccounts(): Promise<IpChangeAccountRecord[]>;
  getAccount(id: number): Promise<IpChangeAccountRecord | null>;
  createAccount(input: { name: string; provider: string; credentialsJson: string }): Promise<number>;
  updateAccount(id: number, patch: { name?: string; credentialsJson?: string }): Promise<void>;
  deleteAccount(id: number): Promise<void>;

  listConfigs(): Promise<IpChangeConfigRecord[]>;
  getConfig(hostId: number): Promise<IpChangeConfigRecord | null>;
  /** 没有就插一行，有就改；返回改完的那一行。 */
  upsertConfig(hostId: number, patch: IpChangeConfigPatch): Promise<IpChangeConfigRecord>;
  updateConfig(hostId: number, patch: IpChangeConfigPatch): Promise<void>;
  deleteConfig(hostId: number): Promise<void>;

  insertEvent(event: IpChangeEventInsert): Promise<number>;
  updateEvent(id: number, patch: IpChangeEventPatch): Promise<void>;
  listEvents(query: { hostId?: number | null; limit: number; offset: number }): Promise<{ items: IpChangeEventRecord[]; total: number }>;
  /** 某台主机自 since 起开始的「真更换」次数（手动 + 自动，不含测试）。 */
  countAttemptsSince(hostId: number, since: Date): Promise<number>;
  /** 某台主机最近一次「真更换」开始的时间。 */
  lastAttemptAt(hostId: number): Promise<Date | null>;
  /** 把还挂着「进行中」的记录改成「结果不确定」（面板重启时用）；返回改了几条。 */
  markRunningEventsUncertain(hostIds: number[] | null, error: string, finishedAt: Date): Promise<number>;
}
