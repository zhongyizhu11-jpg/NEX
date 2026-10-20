import { FormField } from "@/components/ui/form-field";
import WorkspaceHeader from "@/components/WorkspaceHeader";
import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import EmptyState from "@/components/EmptyState";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { renderMixedHtml, describeContentFormat } from "@/lib/htmlContent";
import { trpc } from "@/lib/trpc";
import { Eye, Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

type AnnouncementType = "normal" | "popup";

type AnnouncementForm = {
  id: number;
  title: string;
  content: string;
  type: AnnouncementType;
  targetVersion: string;
  telegramPush: boolean;
};

const emptyForm: AnnouncementForm = {
  id: 0,
  title: "",
  content: "",
  type: "normal",
  targetVersion: "",
  telegramPush: false,
};

function dateText(value?: string | Date | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function renderAnnouncementHtml(content: string) {
  return { __html: renderMixedHtml(content) };
}

function announcementTypeLabel(type: AnnouncementType) {
  if (type === "popup") return "登录弹窗";
  return "普通公告";
}

function announcementSuccessMessage(action: string, data: any) {
  const push = data?.telegramPush;
  if (!push?.requested) return `公告已${action}`;
  return `公告已${action}，TG 推送 ${push.sent || 0}/${push.total || 0}${push.failed ? `，失败 ${push.failed}` : ""}`;
}

export default function Announcements() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const { data: announcements = [], isLoading } = trpc.announcements.list.useQuery();
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [form, setForm] = useState<AnnouncementForm>(emptyForm);

  const invalidateAnnouncementQueries = () => {
    utils.announcements.list.invalidate();
    utils.announcements.popup.invalidate();
    utils.announcements.upgradePopup.invalidate();
  };

  const createAnnouncement = trpc.announcements.create.useMutation({
    onSuccess: (data) => {
      toast.success(data?.telegramPush?.requested ? announcementSuccessMessage("创建", data) : "公告已创建");
      setOpen(false);
      setForm(emptyForm);
      invalidateAnnouncementQueries();
    },
    onError: (error) => toast.error(error.message || "创建失败"),
  });

  const updateAnnouncement = trpc.announcements.update.useMutation({
    onSuccess: (data) => {
      toast.success(data?.telegramPush?.requested ? announcementSuccessMessage("更新", data) : "公告已更新");
      setOpen(false);
      setForm(emptyForm);
      invalidateAnnouncementQueries();
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });

  const deleteAnnouncement = trpc.announcements.delete.useMutation({
    onSuccess: () => {
      toast.success("公告已删除");
      invalidateAnnouncementQueries();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const confirmDialog = useConfirmDialog();
  const confirmDeleteAnnouncement = async (item: any) => {
    if (deleteAnnouncement.isPending) return;
    const confirmed = await confirmDialog({
      title: "删除公告",
      description: `确认删除公告「${item.title}」？删除后所有用户都将看不到它，且无法恢复。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (confirmed) deleteAnnouncement.mutate({ id: item.id });
  };

  const submit = () => {
    const payload = {
      title: form.title.trim(),
      content: form.content.trim(),
      type: form.type,
      targetVersion: null,
      telegramPush: form.telegramPush,
    };
    if (form.id) updateAnnouncement.mutate({ ...payload, id: form.id });
    else createAnnouncement.mutate(payload);
  };

  const edit = (item: any) => {
    const type: AnnouncementType = item.type === "popup" ? "popup" : "normal";
    setForm({
      id: item.id,
      title: item.title || "",
      content: item.content || "",
      type,
      targetVersion: item.targetVersion || "",
      telegramPush: false,
    });
    setOpen(true);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <WorkspaceHeader
          title={<>{isAdmin ? "公告管理" : "公告"}</>}
          description={isAdmin ? "管理普通公告和登录弹窗。" : "查看管理员发布的公告信息。"}
          actions={isAdmin ? (
            <Button onClick={() => { setForm(emptyForm); setOpen(true); }} className="gap-2 max-md:w-[34px] max-md:px-0" aria-label="新增公告">
              <Plus className="h-4 w-4" />
              <span className="max-md:sr-only">新增公告</span>
            </Button>
          ) : undefined}
        />

        {isLoading ? (
          <DataSectionLoading label="正在加载公告" />
        ) : (
          <div className="grid gap-4">
            {announcements.map((item: any) => {
              const type: AnnouncementType = item.type === "popup" ? "popup" : "normal";
              const isPopup = type === "popup";
              return (
                <Card key={item.id}>
                  <CardHeader>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="flex flex-wrap items-center gap-2">
                          <Megaphone className="h-5 w-5" />
                          {item.title}
                          <Badge variant={isPopup ? "default" : "outline"}>{announcementTypeLabel(type)}</Badge>
                        </CardTitle>
                        {!isPopup ? (
                          <CardDescription keep className="mt-2">发布时间：{dateText(item.createdAt || item.updatedAt)}</CardDescription>
                        ) : null}
                      </div>
                      {isAdmin && (
                        <div className="flex gap-2">
                          <Button variant="outline" size="icon" aria-label={`编辑公告 ${item.title}`} onClick={() => edit(item)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" aria-label={`删除公告 ${item.title}`} className="text-destructive" disabled={deleteAnnouncement.isPending} onClick={() => void confirmDeleteAnnouncement(item)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm leading-6 text-foreground/85" dangerouslySetInnerHTML={renderAnnouncementHtml(item.content || "")} />
                  </CardContent>
                </Card>
              );
            })}
            {announcements.length === 0 && (
              <EmptyState icon={<Megaphone />} title="暂无公告" description="当前没有可查看的公告。" />
            )}
          </div>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{form.id ? "编辑公告" : "新增公告"}</DialogTitle>
              <DialogDescription>选择公告展示方式。</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>标题</Label>
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </FormField>
                <FormField className="space-y-2">
                  <Label>类型</Label>
                  <Select
                    value={form.type}
                    onValueChange={(type: AnnouncementType) => setForm((current) => ({
                      ...current,
                      type,
                      targetVersion: "",
                    }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">普通公告</SelectItem>
                      <SelectItem value="popup">登录弹窗</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              <FormField className="flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/15 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Label>同步 Telegram 推送</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仅发送给已绑定 Telegram 且在个人资料中开启公告推送的用户。
                  </p>
                </div>
                <Checkbox
                  checked={form.telegramPush}
                  onCheckedChange={(telegramPush) => setForm({ ...form, telegramPush })}
                />
              </FormField>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>内容</Label>
                    <p className="mt-1 text-xs text-muted-foreground">支持文字、Markdown 和 HTML。</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setPreviewOpen(true)} disabled={!form.content.trim()}>
                    <Eye className="h-4 w-4" />
                    预览
                  </Button>
                </div>
                <Textarea
                  id="announcement-content"
                  className="min-h-56 font-mono text-xs leading-5"
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {form.content.length.toLocaleString()} / 60,000 字符，{describeContentFormat(form.content)}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button
                onClick={submit}
                disabled={
                  !form.title.trim() ||
                  !form.content.trim() ||
                  createAnnouncement.isPending ||
                  updateAnnouncement.isPending
                }
              >
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>公告预览</DialogTitle>
              <DialogDescription>{describeContentFormat(form.content)} 预览。</DialogDescription>
            </DialogHeader>
            <div
              className="max-h-[60svh] overflow-y-auto rounded-lg border bg-background/45 p-4 text-sm leading-6"
              dangerouslySetInnerHTML={renderAnnouncementHtml(form.content)}
            />
            <DialogFooter>
              <Button onClick={() => setPreviewOpen(false)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
