import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Globe2, Loader2, Lock, Pencil, Plus, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import EmptyState from "@/components/EmptyState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { trpc } from "@/lib/trpc";
import {
  DNSPOD_DEFAULT_RECORD_TTL,
  DNSPOD_MAX_CHANGES_PER_SAVE,
  DNSPOD_WRITABLE_RECORD_TYPES,
  dnspodRecordFqdn,
  remainingDnspodChanges,
  validateDnspodRecordDraft,
  type DnspodRecordChange,
  type DnspodRecordDraft,
  type DnspodWritableRecordType,
} from "@shared/dnspodRecords";

/*
  系统设置 › DDNS 服务商下面：DNSPod 解析记录（用的就是上面填的腾讯云 SecretId / SecretKey）。

  编辑 → 暂存 → 统一保存：新增、修改、删除先放进暂存区，记录列表上就地标出来；点保存才一条一条
  写到 DNSPod。保存失败的（和它后面没来得及试的）留在暂存区，带着原因；已经成功的拿掉，再点保存
  不会重复提交。面板自己维护的名字（主机 DDNS、入口组 / 转发组、规则专属域名、落地池直连域名）
  只读 —— 服务端同样会拒绝，这里的只读只是提前告诉你为什么。
*/

type StagedChange = DnspodRecordChange & {
  /** 暂存区里显示的一句话。 */
  summary: string;
  error?: string;
  uncertain?: boolean;
};

type EditorState = {
  /** 改的是哪条已有记录；新建时为空。 */
  recordId: string | null;
  revision: string | null;
  /** 改的是暂存区里哪条新增；没有就是新的一条。 */
  stagedKey: string | null;
  draft: { subdomain: string; type: DnspodWritableRecordType; lineId: string; value: string; ttl: string };
};

const GROUP_PAGE = 30;

function newKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function draftSummary(draft: DnspodRecordDraft, domain: string, lineName: string) {
  return `${dnspodRecordFqdn(draft.subdomain, domain)} ${draft.type} [${lineName}] → ${draft.value}（TTL ${draft.ttl}）`;
}

export default function DnspodRecordsCard() {
  const utils = trpc.useUtils();
  const domainsQuery = trpc.dnsRecords.domains.useQuery(undefined, { staleTime: 60_000, retry: false });
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");
  const [visibleGroups, setVisibleGroups] = useState(GROUP_PAGE);
  const [staged, setStaged] = useState<StagedChange[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState("");

  const domainList = useMemo(() => domainsQuery.data?.domains || [], [domainsQuery.data?.domains]);
  useEffect(() => {
    if (domain || domainList.length === 0) return;
    const preferred = domainsQuery.data?.defaultDomain;
    setDomain(domainList.some((item) => item.name === preferred) ? String(preferred) : domainList[0].name);
  }, [domain, domainList, domainsQuery.data?.defaultDomain]);

  const recordsQuery = trpc.dnsRecords.records.useQuery({ domain }, { enabled: !!domain, retry: false, staleTime: 15_000 });
  // 线路按域名套餐来，只在要编辑时才去拿。
  const linesQuery = trpc.dnsRecords.lines.useQuery({ domain }, { enabled: !!domain && !!editor, retry: false, staleTime: 10 * 60_000 });
  const applyMutation = trpc.dnsRecords.applyChanges.useMutation();

  const lines = linesQuery.data?.lines || [];
  const lineName = (lineId: string, fallback = "") => lines.find((line) => line.id === lineId)?.name || fallback || lineId;

  const stagedByRecord = useMemo(() => {
    const map = new Map<string, StagedChange>();
    for (const change of staged) if (change.kind !== "create") map.set(change.recordId, change);
    return map;
  }, [staged]);

  const groups = useMemo(() => {
    const all = recordsQuery.data?.groups || [];
    const keyword = search.trim().toLowerCase();
    if (!keyword) return all;
    return all.filter((group) => group.fqdn.includes(keyword)
      || group.records.some((record) => [record.type, record.line, record.value].some((text) => text.toLowerCase().includes(keyword))));
  }, [recordsQuery.data?.groups, search]);

  useEffect(() => setVisibleGroups(GROUP_PAGE), [domain, search]);

  const save = async () => {
    if (!domain || staged.length === 0) return true;
    try {
      const { results } = await applyMutation.mutateAsync({
        domain,
        changes: staged.map(({ summary: _summary, error: _error, uncertain: _uncertain, ...change }) => change as DnspodRecordChange),
      });
      const byKey = new Map(results.map((result) => [result.key, result]));
      const remaining = remainingDnspodChanges(staged, results).map((change) => {
        const result = byKey.get(change.key);
        return {
          ...change,
          error: result?.status === "skipped" ? "前面一条没保存成功，这条还没提交" : result?.error,
          uncertain: !!result?.uncertain,
        };
      });
      setStaged(remaining);
      await utils.dnsRecords.records.invalidate({ domain });
      const done = staged.length - remaining.length;
      if (remaining.length === 0) {
        toast.success(`已保存 ${done} 条解析变更`);
        return true;
      }
      toast.error(`${done ? `已保存 ${done} 条，` : ""}还有 ${remaining.length} 条没保存，原因见暂存区`);
      return false;
    } catch (error) {
      // 整批没做（凭据、网络、托管名字读不出来）：暂存区原样留着。
      toast.error(error instanceof Error && error.message ? error.message : "保存解析变更失败");
      return false;
    }
  };

  useSaveDockItem({
    id: "system.dnspodRecords",
    label: "DNSPod 解析记录",
    dirty: staged.length > 0,
    pending: applyMutation.isPending,
    save,
    reset: () => setStaged([]),
  });

  const pushChange = (change: StagedChange, replaceKey?: string | null) => {
    setStaged((current) => {
      const withoutOld = current.filter((item) => item.key !== replaceKey && !(change.kind !== "create" && item.kind !== "create" && item.recordId === change.recordId));
      if (withoutOld.length >= DNSPOD_MAX_CHANGES_PER_SAVE) {
        toast.error(`暂存区最多 ${DNSPOD_MAX_CHANGES_PER_SAVE} 条，先保存一次再继续`);
        return current;
      }
      return [...withoutOld, change];
    });
  };

  const openCreate = (subdomain = "") => {
    setEditorError("");
    setEditor({ recordId: null, revision: null, stagedKey: null, draft: { subdomain, type: "A", lineId: "0", value: "", ttl: String(DNSPOD_DEFAULT_RECORD_TTL) } });
  };

  const openEdit = (record: { id: string; revision: string; subdomain: string; type: string; lineId: string; value: string; ttl: number }) => {
    setEditorError("");
    const pending = stagedByRecord.get(record.id);
    const base = pending?.kind === "update" ? pending.record : { ...record, type: record.type as DnspodWritableRecordType, ttl: record.ttl };
    setEditor({
      recordId: record.id,
      revision: record.revision,
      stagedKey: null,
      draft: { subdomain: base.subdomain, type: base.type, lineId: base.lineId, value: base.value.replace(/\.$/, ""), ttl: String(base.ttl) },
    });
  };

  const openEditStagedCreate = (change: StagedChange) => {
    if (change.kind !== "create") return;
    setEditorError("");
    setEditor({ recordId: null, revision: null, stagedKey: change.key, draft: { ...change.record, ttl: String(change.record.ttl) } });
  };

  const submitEditor = () => {
    if (!editor) return;
    const checked = validateDnspodRecordDraft({ ...editor.draft, ttl: Number(editor.draft.ttl), lineName: lineName(editor.draft.lineId) });
    if (!checked.ok) {
      setEditorError(checked.error);
      return;
    }
    const record = checked.record;
    const summary = draftSummary(record, domain, lineName(record.lineId));
    if (editor.recordId && editor.revision) {
      pushChange({ key: newKey(), kind: "update", recordId: editor.recordId, revision: editor.revision, record, summary: `修改 ${summary}` });
    } else {
      pushChange({ key: editor.stagedKey || newKey(), kind: "create", record, summary: `新增 ${summary}` }, editor.stagedKey);
    }
    setEditor(null);
  };

  const stageDelete = (record: { id: string; revision: string; fqdn: string; type: string; line: string; value: string }) => {
    pushChange({ key: newKey(), kind: "delete", recordId: record.id, revision: record.revision, summary: `删除 ${record.fqdn} ${record.type} [${record.line}] ${record.value}` });
  };

  const unstage = (key: string) => setStaged((current) => current.filter((item) => item.key !== key));

  const notConfigured = domainsQuery.data && !domainsQuery.data.configured;
  const recordsData = recordsQuery.data;

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="h-4 w-4 text-primary" />
          DNSPod 解析记录
        </CardTitle>
        <CardDescription>
          直接在面板里管理 DNSPod 上的 A / AAAA / CNAME 记录，可以按运营商线路（电信、联通、移动、境外……）分别解析。改动先暂存，统一保存才写入。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {domainsQuery.isLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : domainsQuery.error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>读取域名列表失败</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {domainsQuery.error.message}
              <Button size="xs" variant="outline" onClick={() => void domainsQuery.refetch()}>重试</Button>
            </AlertDescription>
          </Alert>
        ) : notConfigured ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>还不能管理解析</AlertTitle>
            <AlertDescription>{domainsQuery.data?.reason}</AlertDescription>
          </Alert>
        ) : domainList.length === 0 ? (
          <EmptyState title="这个 DNSPod 账号下没有域名" description="先到 DNSPod 控制台添加域名，再回来刷新。" actions={<Button size="sm" variant="outline" onClick={() => void domainsQuery.refetch()}>刷新</Button>} />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1 space-y-1.5">
                <Label>域名</Label>
                <Select value={domain} onValueChange={setDomain} disabled={staged.length > 0}>
                  <SelectTrigger aria-label="DNSPod 域名"><SelectValue placeholder="选择域名" /></SelectTrigger>
                  <SelectContent>
                    {domainList.map((item) => (
                      <SelectItem key={item.id} value={item.name}>
                        {item.name}{item.recordCount !== null ? `（${item.recordCount} 条）` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[10rem] flex-1 space-y-1.5">
                <Label>搜索</Label>
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="子域名、记录值、线路" />
              </div>
              <Button variant="outline" onClick={() => void recordsQuery.refetch()} disabled={!domain || recordsQuery.isFetching}>
                <RefreshCw className={`mr-1.5 h-4 w-4 ${recordsQuery.isFetching ? "animate-spin" : ""}`} />
                刷新
              </Button>
              <Button onClick={() => openCreate()} disabled={!domain || !recordsData}>
                <Plus className="mr-1.5 h-4 w-4" />
                新增记录
              </Button>
            </div>
            {staged.length > 0 && <p className="text-xs text-muted-foreground">暂存区里还有变更时不能切换域名：先保存或放弃。</p>}

            {staged.length > 0 && (
              <section className="space-y-2 rounded-lg border border-[var(--fx-stroke-base)] p-3" aria-label="暂存的解析变更">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-secondary-type font-medium">暂存的变更（{staged.length}）</h3>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setStaged([])} disabled={applyMutation.isPending}>放弃全部</Button>
                    <Button size="sm" data-dock-save onClick={() => void save()} disabled={applyMutation.isPending}>
                      {applyMutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                      统一保存
                    </Button>
                  </div>
                </div>
                <ul className="space-y-1.5">
                  {staged.map((change) => (
                    <li key={change.key} className="flex flex-wrap items-start justify-between gap-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="break-all font-mono text-xs">{change.summary}</div>
                        {change.error && (
                          <div className={`mt-0.5 text-xs ${change.uncertain ? "text-[var(--fx-warn-text)]" : "text-[var(--fx-down-text)]"}`}>
                            {change.uncertain ? "结果不确定：" : ""}{change.error}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        {change.kind === "create" && (
                          <Button size="xs" variant="ghost" onClick={() => openEditStagedCreate(change)} aria-label="编辑这条暂存">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button size="xs" variant="ghost" onClick={() => unstage(change.key)} aria-label="撤销这条暂存">
                          <Undo2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {recordsQuery.isLoading ? (
              <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
            ) : recordsQuery.error ? (
              // 读失败就是失败：不显示成「没有记录」，免得被当成域名是空的。
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>读取解析记录失败</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  {recordsQuery.error.message}
                  <Button size="xs" variant="outline" onClick={() => void recordsQuery.refetch()}>重试</Button>
                </AlertDescription>
              </Alert>
            ) : recordsData && recordsData.total === 0 ? (
              <EmptyState title="这个域名下还没有解析记录" description="点「新增记录」加一条，保存后才会写入 DNSPod。" />
            ) : recordsData ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  共 {recordsData.total} 条记录、{recordsData.groups.length} 个子域名{search.trim() ? `，匹配 ${groups.length} 个` : ""}。标了「面板管理」的名字由主机 DDNS、入口组 / 转发组、规则专属域名或落地池在维护，请到对应位置修改。
                </p>
                {groups.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的子域名。</p>}
                {groups.slice(0, visibleGroups).map((group) => (
                  <div key={group.subdomain} className="rounded-lg border border-[var(--fx-stroke-base)]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--fx-stroke-base)] px-3 py-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-sm font-medium">{group.fqdn}</span>
                        {group.managedBy.length > 0 && (
                          <Badge tone="info" size="sm" className="gap-1"><Lock className="h-3 w-3" />面板管理</Badge>
                        )}
                      </div>
                      {group.managedBy.length === 0 && (
                        <Button size="xs" variant="ghost" onClick={() => openCreate(group.subdomain)}>
                          <Plus className="h-3.5 w-3.5" />加一条
                        </Button>
                      )}
                    </div>
                    {group.managedBy.length > 0 && (
                      <p className="px-3 pt-2 text-xs text-muted-foreground">{group.managedBy.join("；")}。这里只读，删除或修改会被拒绝。</p>
                    )}
                    <ul className="divide-y divide-[var(--fx-stroke-base)]">
                      {group.records.map((record) => {
                        const pending = stagedByRecord.get(record.id);
                        return (
                          <li key={record.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                            <Badge variant="secondary" size="sm">{record.type}</Badge>
                            <span className="text-xs text-muted-foreground">{record.line}</span>
                            <span className={`min-w-0 flex-1 break-all font-mono text-xs ${pending?.kind === "delete" ? "line-through opacity-60" : ""}`}>
                              {record.value}
                              {pending?.kind === "update" && <span className="ml-2 text-[var(--fx-accent)]">→ {pending.record.value}（{pending.record.lineName || pending.record.lineId}）</span>}
                            </span>
                            <span className="text-xs text-muted-foreground">TTL {record.ttl}</span>
                            {record.status === "DISABLE" && <Badge tone="neutral" size="sm">已暂停</Badge>}
                            {pending && <Badge tone="warn" size="sm">{pending.kind === "delete" ? "待删除" : "待保存"}</Badge>}
                            {record.editable ? (
                              <div className="flex gap-1">
                                {pending ? (
                                  <Button size="xs" variant="ghost" onClick={() => unstage(pending.key)} aria-label="撤销">
                                    <Undo2 className="h-3.5 w-3.5" />
                                  </Button>
                                ) : null}
                                <Button size="xs" variant="ghost" onClick={() => openEdit(record)} aria-label="编辑记录">
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                {pending?.kind !== "delete" && (
                                  <Button size="xs" variant="ghost" onClick={() => stageDelete(record)} aria-label="删除记录">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground" title={record.readOnlyReason || undefined}>只读</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                {groups.length > visibleGroups && (
                  <div className="flex justify-center">
                    <Button size="sm" variant="outline" onClick={() => setVisibleGroups((count) => count + GROUP_PAGE)}>
                      再显示 {Math.min(GROUP_PAGE, groups.length - visibleGroups)} 个（还有 {groups.length - visibleGroups} 个）
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      <Dialog open={!!editor} onOpenChange={(open) => { if (!open) setEditor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editor?.recordId ? "修改解析记录" : "新增解析记录"}</DialogTitle>
            <DialogDescription>确定后放进暂存区，点「统一保存」才写入 DNSPod。</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="dnspod-subdomain">主机记录</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="dnspod-subdomain"
                    value={editor.draft.subdomain}
                    onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, subdomain: event.target.value } })}
                    placeholder="www，主域名本身填 @"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">.{domain}</span>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>记录类型</Label>
                  <Select value={editor.draft.type} onValueChange={(value) => setEditor({ ...editor, draft: { ...editor.draft, type: value as DnspodWritableRecordType } })}>
                    <SelectTrigger aria-label="记录类型"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DNSPOD_WRITABLE_RECORD_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>线路</Label>
                  <Select
                    value={editor.draft.lineId}
                    onValueChange={(value) => setEditor({ ...editor, draft: { ...editor.draft, lineId: value } })}
                    disabled={!linesQuery.data}
                  >
                    <SelectTrigger aria-label="解析线路"><SelectValue placeholder={linesQuery.isLoading ? "读取线路…" : "选择线路"} /></SelectTrigger>
                    <SelectContent>
                      {lines.map((line) => <SelectItem key={line.id} value={line.id}>{line.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {linesQuery.error && <p className="text-xs text-[var(--fx-down-text)]">读取线路失败：{linesQuery.error.message}</p>}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dnspod-value">记录值</Label>
                <Input
                  id="dnspod-value"
                  value={editor.draft.value}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, value: event.target.value } })}
                  placeholder={editor.draft.type === "A" ? "IPv4，例如 203.0.113.10" : editor.draft.type === "AAAA" ? "IPv6，例如 2001:db8::10" : "目标域名，例如 edge.example.net"}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dnspod-ttl">TTL（秒）</Label>
                <Input
                  id="dnspod-ttl"
                  value={editor.draft.ttl}
                  onChange={(event) => setEditor({ ...editor, draft: { ...editor.draft, ttl: event.target.value.replace(/\D/g, "").slice(0, 6) } })}
                  inputMode="numeric"
                />
                <p className="text-xs text-muted-foreground">DNSPod 免费版最低 600 秒；更低的值会被 DNSPod 拒绝。</p>
              </div>
              {editorError && <p className="text-sm text-[var(--fx-down-text)]">{editorError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>取消</Button>
            <Button onClick={submitEditor} disabled={!linesQuery.data}>放进暂存区</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
