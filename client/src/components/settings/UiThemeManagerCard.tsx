import { useRef, useState } from "react";
import { Download, Link2, Loader2, PackagePlus, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { UiThemeSwatch } from "./UiThemeSwatch";

/*
  设置 › 个性化 › 主题管理（只有管理员）：装、更新、卸载界面主题包。

  面板自带经典、珍珠、液态玻璃三套；别的主题都是主题包（shared/uiThemePackage.ts），三条路装：
    · 官方主题库 —— 随面板发布的那几套，点一下就装，不用外网；
    · 上传压缩包 —— ZIP / TAR.GZ；
    · 从链接安装 —— 填压缩包直链，面板去下。
  装好以后它就和内置的排在一起（上面那张「界面主题」卡片、顶栏调色盘），在那里选用。
  这里只管「有没有」，不管「用哪套」。
*/

const SOURCE_LABELS: Record<string, string> = { official: "官方主题库", upload: "上传", url: "链接" };

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() || "" : result);
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 把接口给的 base64 压缩包存成文件。 */
function saveArchive(filename: string, dataBase64: string) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1_000);
}

export function UiThemeManagerCard() {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const { data, isLoading } = trpc.uiThemes.list.useQuery(undefined, { refetchOnWindowFocus: false });
  const fileInput = useRef<HTMLInputElement>(null);
  const [replace, setReplace] = useState(false);
  const [url, setUrl] = useState("");
  const [exporting, setExporting] = useState<string | null>(null);

  /*
    装 / 卸之后三份数据都要重拉：这张卡片的名单；publicInfo（所有页面靠它知道装着哪些主题、样式去哪取）；
    getSettings（卸载的正好是站点默认时，服务端已经把站点默认改回了经典）。
  */
  const refresh = () => Promise.all([
    utils.uiThemes.list.invalidate(),
    utils.system.publicInfo.invalidate(),
    utils.system.getSettings.invalidate(),
  ]);
  const installed = (result: { theme: { name: string; version: string }; replaced: boolean } | undefined) => {
    if (result) toast.success(`${result.replaced ? "已更新" : "已安装"}「${result.theme.name}」${result.theme.version}，可以在上面的「界面主题」里选用`);
    return refresh();
  };
  const installOfficial = trpc.uiThemes.installOfficial.useMutation({ onSuccess: installed, onError: (error) => toast.error(error.message || "安装失败") });
  const installFromUpload = trpc.uiThemes.installFromUpload.useMutation({ onSuccess: installed, onError: (error) => toast.error(error.message || "安装失败") });
  const installFromUrl = trpc.uiThemes.installFromUrl.useMutation({
    onSuccess: async (result) => {
      setUrl("");
      await installed(result);
    },
    onError: (error) => toast.error(error.message || "安装失败"),
  });
  const uninstall = trpc.uiThemes.uninstall.useMutation({
    onSuccess: async (result) => {
      toast.success(result?.siteThemeReset ? "已卸载。它原来是站点默认主题，站点默认已改回经典" : "已卸载");
      await refresh();
    },
    onError: (error) => toast.error(error.message || "卸载失败"),
  });
  const busy = installOfficial.isPending || installFromUpload.isPending || installFromUrl.isPending || uninstall.isPending;

  const handleUninstall = async (theme: { id: string; name: string }) => {
    const confirmed = await confirmDialog({
      title: "卸载主题",
      description: `确定卸载「${theme.name}」？正在用它的设备会回到站点默认主题；它是站点默认的话，站点默认会改回经典。以后可以重新安装。`,
      confirmText: "卸载",
      tone: "destructive",
    });
    if (confirmed) uninstall.mutate({ id: theme.id });
  };

  const handleFile = async (file?: File | null) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!file) return;
    const limit = data?.limits.archiveBytes || 6 * 1024 * 1024;
    if (file.size > limit) {
      toast.error(`主题包不能超过 ${Math.round(limit / 1024 / 1024)}MB`);
      return;
    }
    try {
      installFromUpload.mutate({ dataBase64: await fileToBase64(file), replace });
    } catch {
      toast.error("读取文件失败，请重新选择");
    }
  };

  const handleUrl = () => {
    const value = url.trim();
    if (!/^https?:\/\//i.test(value)) {
      toast.error("请填写 http:// 或 https:// 开头的压缩包直链");
      return;
    }
    installFromUrl.mutate({ url: value, replace });
  };

  const handleExport = async (id: string) => {
    setExporting(id);
    try {
      const exported = await utils.uiThemes.exportArchive.fetch({ id });
      saveArchive(exported.filename, exported.dataBase64);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "导出失败");
    } finally {
      setExporting(null);
    }
  };

  const handleStarter = async () => {
    setExporting("starter");
    try {
      const starter = await utils.uiThemes.starter.fetch();
      saveArchive(starter.filename, starter.dataBase64);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "下载失败");
    } finally {
      setExporting(null);
    }
  };

  const official = data?.official || [];
  const officialIds = new Set(official.map((theme) => theme.id));
  // 官方主题库里的那几套在上面那一格里管；这里列的是另外装的（上传的、从链接装的）
  const others = (data?.installed || []).filter((theme) => !officialIds.has(theme.id));

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackagePlus className="h-4 w-4 text-primary" />
          主题管理
        </CardTitle>
        <CardDescription>
          面板自带经典、珍珠、液态玻璃三套界面主题，其余的按需安装：从官方主题库点一下，或者上传 / 用链接装别人做的主题包。装好以后在上面的「界面主题」和顶栏调色盘里选用；不装的主题不占用任何人的流量。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">官方主题库</h3>
          {isLoading ? (
            <p className="text-xs text-muted-foreground">正在读取主题库…</p>
          ) : official.length === 0 ? (
            <p className="text-xs text-muted-foreground">这个面板的安装包里没有带官方主题库（自己构建时没有拷 themes/official）。可以用下面的上传或链接安装。</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:max-w-3xl sm:grid-cols-3">
              {official.map((theme) => {
                const pending = (installOfficial.isPending && installOfficial.variables?.id === theme.id)
                  || (uninstall.isPending && uninstall.variables?.id === theme.id);
                return (
                  <div key={theme.id} className="flex flex-col gap-2 rounded-lg border border-border/40 p-2.5">
                    <UiThemeSwatch id={theme.id} preview={theme.preview} />
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{theme.name}</span>
                      {theme.installedVersion ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">已安装</span>
                      ) : null}
                    </span>
                    <span className="flex-1 text-xs leading-5 text-muted-foreground">{theme.description}</span>
                    <span className="flex flex-wrap gap-2">
                      {!theme.installedVersion ? (
                        <Button type="button" size="sm" className="gap-1.5" disabled={busy} onClick={() => installOfficial.mutate({ id: theme.id })}>
                          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                          安装
                        </Button>
                      ) : (
                        <>
                          {theme.updateAvailable ? (
                            <Button type="button" size="sm" className="gap-1.5" disabled={busy} onClick={() => installOfficial.mutate({ id: theme.id })}>
                              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                              更新到 {theme.version}
                            </Button>
                          ) : null}
                          <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => handleUninstall(theme)}>
                            <Trash2 className="h-3.5 w-3.5" />
                            卸载
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {others.length > 0 ? (
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-foreground">另外安装的主题</h3>
            <ul className="divide-y divide-border/40 rounded-lg border border-border/40 sm:max-w-3xl">
              {others.map((theme) => (
                <li key={theme.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium text-foreground">
                      {theme.name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{theme.version} · {SOURCE_LABELS[theme.source] || theme.source}{theme.author ? ` · ${theme.author}` : ""}</span>
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">{theme.description || theme.id}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={exporting === theme.id} onClick={() => handleExport(theme.id)}>
                      {exporting === theme.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                      导出
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => handleUninstall(theme)}>
                      <Trash2 className="h-3.5 w-3.5" />
                      卸载
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">安装别的主题</h3>
          <p className="text-xs leading-5 text-muted-foreground sm:max-w-3xl">
            主题包是一个压缩包（ZIP 或 TAR.GZ），里面是 theme.json 和样式文件。主题只能改外观，不能带脚本，也不能引用外网地址；安装时面板会检查。只装你信得过的来源。
          </p>
          <div className="flex flex-col gap-3 sm:max-w-3xl">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/my-theme.zip"
                aria-label="主题包直链"
                disabled={busy}
                className="sm:flex-1"
              />
              <Button type="button" variant="outline" className="gap-2" disabled={busy || !url.trim()} onClick={handleUrl}>
                {installFromUrl.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                从链接安装
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".zip,.tgz,.gz,.tar,application/zip,application/gzip"
                className="hidden"
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
              <Button type="button" variant="outline" className="gap-2" disabled={busy} onClick={() => fileInput.current?.click()}>
                {installFromUpload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                上传压缩包
              </Button>
              <Button type="button" variant="ghost" className="gap-2" disabled={exporting === "starter"} onClick={handleStarter}>
                {exporting === "starter" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                下载开发模板
              </Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={replace} onCheckedChange={setReplace} disabled={busy} />
              替换已安装的同名主题（升级主题时勾上）
            </label>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
