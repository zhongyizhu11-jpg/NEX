import { resolveSiteTitle } from "@shared/brand";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";
import { createHomepageDocument } from "@/lib/homepageHtml";
import { trpc } from "@/lib/trpc";
import { Activity, ArrowRight, ArrowUpRight, BookOpen, ChevronDown, Gauge, LogIn, Moon, Network, Route, Server, ShieldCheck, Sun, Users, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { docsUrl } from "@/lib/docsLinks";

/*
  首页照参考站（New API / Vexo）的版式来：吸顶的毛玻璃导航；首屏左文右卡 —— 左边一枚
  胶囊标签、渐变的大标题、一段说明、三个按钮、一排支持的转发方式，右边一张「终端卡」
  （这里是一条规则的示意：路径 + 近 24 小时用量）；下面依次是数字带、2+1 / 1+2 的功能格、
  三步上手、常见问题、收尾号召、页脚。颜色全部走令牌（样式在 workspace.css 首页那一节）。
*/
const features: { title: string; text: string; icon: LucideIcon; detail: string; wide?: boolean }[] = [
  { title: "资源，一处掌握", text: "集中查看主机、线路与规则。先看到状态，再处理需要关注的问题。", icon: Server, detail: "主机 / 链路 / 规则", wide: true },
  { title: "路径，一目了然", text: "从入口到出口，清楚呈现每一跳。支持端口转发、隧道与转发链。", icon: Network, detail: "入口 → 中继 → 出口" },
  { title: "权限，各有边界", text: "管理员分配资源和套餐；用户在自己的工作空间内使用与管理。", icon: ShieldCheck, detail: "用户 / 资源 / 套餐" },
  { title: "用量，心中有数", text: "查看累计用量与近 24 小时趋势，掌握流量和套餐的使用情况。", icon: Gauge, detail: "流量 / 连接 / 有效期", wide: true },
];
const stats = [
  { value: "3", label: "种路径形态", hint: "端口转发 · 隧道 · 转发链" },
  { value: "6", label: "种转发工具", hint: "iptables · nftables · realm · gost · socat · nginx" },
  { value: "24h", label: "用量趋势", hint: "累计用量与近 24 小时走势" },
  { value: "1", label: "条命令接入", hint: "按安装指引一条命令连上 Agent" },
];
const supported = ["端口转发", "隧道", "转发链", "iptables", "nftables", "realm", "gost", "socat", "nginx"];
const routeNodes: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: Server, title: "入口", detail: "接收连接" },
  { icon: Network, title: "链路", detail: "传递流量" },
  { icon: ArrowUpRight, title: "出口", detail: "到达目标" },
];
const demoBars = [28, 42, 36, 58, 50, 72, 64, 80, 56, 68, 88, 74];
const docsHomeUrl = docsUrl();
const journeys: Record<"user" | "admin", { title: string; text: string; icon: LucideIcon }[]> = {
  user: [
    { title: "登录工作空间", text: "使用已开通的账号登录，查看分配给你的资源和套餐。", icon: LogIn },
    { title: "创建转发规则", text: "选择线路，填写入口端口和目标地址；规则名称可留空。", icon: Route },
    { title: "查看连接与用量", text: "启用规则后，检查运行状态、连接次数和流量趋势。", icon: Activity },
  ],
  admin: [
    { title: "接入你的主机", text: "在主机管理中添加服务器，按安装指引连接 Agent。", icon: Server },
    { title: "组织网络路径", text: "根据业务选择端口转发、隧道或多跳链路，配置入口与出口。", icon: Network },
    { title: "分配并管理资源", text: "配置用户权限和套餐，在总览中持续关注运行状态。", icon: Users },
  ],
};

export function CustomPublicHome({ html }: { html: string }) {
  return <iframe title="NEX 自定义首页" className="h-svh w-full border-0 bg-background"
    sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
    srcDoc={createHomepageDocument(html)} />;
}

type PublicHomeViewProps = {
  siteTitle: string;
  logoSrc: string;
  version?: string;
  repoUrl?: string;
  registrationEnabled?: boolean;
  dark: boolean;
  onToggleTheme: () => void;
};

function PublicHomeView({ siteTitle, logoSrc, version, repoUrl, registrationEnabled, dark, onToggleTheme }: PublicHomeViewProps) {
  const [journey, setJourney] = useState<"user" | "admin">("user");
  const primaryHref = registrationEnabled === true ? "/login?mode=register" : "/login";
  const primaryLabel = registrationEnabled === true ? "创建账号，开始使用" : "登录工作空间";
  return (
    <div className="public-home-shell min-h-screen text-foreground">
      <a className="workspace-skip-link" href="#public-content">跳到主要内容</a>
      <header className="public-home-nav">
        <div className="public-home-container public-home-nav-inner">
          <Link href="/" className="public-home-brand">
            <img src={logoSrc} alt="" />
            <span>{siteTitle}</span>
          </Link>
          <nav aria-label="首页导航" className="public-home-nav-links">
            <a href="#features" className="public-nav-link hidden sm:inline-flex">功能</a>
            <a href="#getting-started" className="public-nav-link hidden sm:inline-flex">如何开始</a>
            <a href={docsHomeUrl} className="public-nav-link hidden sm:inline-flex">使用文档<ArrowUpRight size={13} aria-hidden="true" /></a>
            <button type="button" className="public-icon-button" onClick={onToggleTheme} aria-label={dark ? "切换浅色模式" : "切换深色模式"}>
              {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            </button>
            <Button size="sm" asChild className="public-nav-cta"><Link href="/login">登录</Link></Button>
          </nav>
        </div>
      </header>
      <main id="public-content" tabIndex={-1}>
        <section className="public-hero" aria-labelledby="home-title">
          <div className="public-hero-glow" aria-hidden="true" />
          <div className="public-hero-grid" aria-hidden="true" />
          <div className="public-home-container public-hero-inner">
            <div className="public-hero-copy">
              <p className="public-hero-badge"><span className="public-hero-badge-dot" aria-hidden="true" />网络转发工作空间</p>
              <h1 id="home-title" className="public-hero-title">复杂的网络，<br /><span className="public-gradient-text">清晰地掌握。</span></h1>
              <p className="public-hero-lead">让主机、线路与转发井然有序。在 {siteTitle}，从一条清晰的路径开始：状态、用量和每一跳，都在同一个面板里。</p>
              <div className="public-hero-actions">
                <Button size="lg" asChild className="public-cta"><Link href={primaryHref}>{primaryLabel}<ArrowRight size={16} aria-hidden="true" /></Link></Button>
                <Button size="lg" variant="outline" asChild className="public-cta"><a href="#getting-started">了解使用流程</a></Button>
                <Button size="lg" variant="outline" asChild className="public-cta"><a href={docsHomeUrl}><BookOpen size={16} aria-hidden="true" />使用文档</a></Button>
              </div>
              <p className="public-account-note">{registrationEnabled === false ? "当前未开放注册。需要账号或资源？请联系站点管理员。" : "已有账号？从右上角登录，继续你的工作。"}</p>
              <div className="public-hero-support">
                <p className="public-eyebrow">支持的转发方式</p>
                <p className="public-hero-support-note">内核转发、用户态工具、隧道与多跳链路，在同一个面板里配置。</p>
                <ul className="public-chip-row" aria-label="支持的转发方式">{supported.map((item) => <li key={item} className="public-chip">{item}</li>)}</ul>
              </div>
            </div>
            <figure className="public-demo" aria-label="一条转发规则的示意">
              <div className="public-demo-tabs" role="presentation">
                <span className="is-active">规则</span><span>链路</span><span>用量</span>
                <span className="public-demo-status"><i aria-hidden="true" />运行中</span>
              </div>
              <div className="public-demo-head">
                <span className="public-demo-method">TCP</span>
                <code>:8443 → 10.0.0.8:443</code>
                <span className="public-demo-head-meta">HK entry 01</span>
              </div>
              <div className="public-demo-section">
                <p className="public-demo-label">路径</p>
                <div className="public-network-route">
                  {routeNodes.map(({ icon: Icon, title, detail }, index) => <div key={title} className="public-network-node">
                    <div className="public-network-node-icon"><Icon size={20} strokeWidth={1.75} aria-hidden="true" /></div>
                    <strong>{title}</strong><small>{detail}</small>
                    {index < routeNodes.length - 1 && <ArrowRight className="public-network-arrow" size={16} aria-hidden="true" />}
                  </div>)}
                </div>
              </div>
              <div className="public-demo-section">
                <p className="public-demo-label">近 24 小时</p>
                <div className="public-demo-bars" aria-hidden="true">{demoBars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
                <dl className="public-demo-stats">
                  <div><dt>入站</dt><dd>4.2 GB</dd></div>
                  <div><dt>出站</dt><dd>3.8 GB</dd></div>
                  <div><dt>连接</dt><dd>128</dd></div>
                  <div><dt>延迟</dt><dd>12 ms</dd></div>
                </dl>
              </div>
              <figcaption className="public-demo-foot"><span>示意数据</span><span>状态可见 · 用量可查</span></figcaption>
            </figure>
          </div>
        </section>
        <section className="public-stats" aria-label="能力概览">
          <div className="public-home-container public-stats-grid">
            {stats.map((item) => <div key={item.label} className="public-stat"><strong>{item.value}</strong><span>{item.label}</span><small>{item.hint}</small></div>)}
          </div>
        </section>
        <section id="features" className="public-section" aria-labelledby="home-features">
          <div className="public-home-container">
            <div className="public-section-heading">
              <p className="public-eyebrow">工作空间</p>
              <h2 id="home-features">少一些切换，多一些掌握。</h2>
              <p>从配置到日常使用，每一步都有清楚的去处。</p>
            </div>
            <div className="public-bento">
              {features.map(({ title, text, icon: Icon, detail, wide }, index) => <article key={title} className={wide ? "public-bento-card is-wide" : "public-bento-card"}>
                <div className="public-bento-top">
                  <span className="public-bento-icon"><Icon size={20} strokeWidth={1.75} aria-hidden="true" /></span>
                  <span className="public-bento-num">0{index + 1}</span>
                </div>
                <h3>{title}</h3><p>{text}</p><small>{detail}</small>
              </article>)}
            </div>
          </div>
        </section>
        <section id="getting-started" className="public-section public-section-alt" aria-labelledby="home-start">
          <div className="public-home-container">
            <div className="public-section-heading is-split">
              <div><p className="public-eyebrow">开始使用</p><h2 id="home-start">从你的角色出发。</h2></div>
              <div className="public-journey-switch" role="group" aria-label="选择使用方式">
                <button type="button" aria-pressed={journey === "user"} onClick={() => setJourney("user")}>使用服务</button>
                <button type="button" aria-pressed={journey === "admin"} onClick={() => setJourney("admin")}>管理网络</button>
              </div>
            </div>
            <ol className="public-journey" aria-live="polite">{journeys[journey].map(({ title, text, icon: Icon }, index) => <li key={title}>
              <div className="public-journey-icon"><Icon size={24} strokeWidth={1.5} aria-hidden="true" /><span aria-hidden="true">{index + 1}</span></div>
              <h3>{title}</h3><p>{text}</p>
            </li>)}</ol>
            <a href={docsHomeUrl} className="public-nav-link public-journey-more"><BookOpen size={16} aria-hidden="true" />查看完整操作指南<ArrowUpRight size={14} aria-hidden="true" /></a>
          </div>
        </section>
        <section className="public-section" aria-labelledby="home-faq">
          <div className="public-home-container public-faq">
            <div><p className="public-eyebrow">使用之前</p><h2 id="home-faq">先把疑问说清楚。</h2></div>
            <div className="public-faq-list">
              <details><summary>使用前需要准备什么？<ChevronDown size={16} aria-hidden="true" /></summary><p>使用服务需要一个账号、可用线路和目标地址。线路权限与套餐由站点管理员配置；管理自己的网络还需要可安装 Agent 的服务器。</p></details>
              <details><summary>如何获得账号和可用资源？<ChevronDown size={16} aria-hidden="true" /></summary><p>{registrationEnabled === true ? "本站已开放注册，可先创建账号。可用资源以登录后显示的权限和套餐为准。" : registrationEnabled === false ? "本站当前未开放自行注册，请联系站点管理员获取账号与资源权限。已有账号可直接登录。" : "可先登录已有账号。注册方式与资源权限以站点管理员的设置为准。"}</p></details>
              <details><summary>手机上可以完成管理吗？<ChevronDown size={16} aria-hidden="true" /></summary><p>可以。工作空间支持手机浏览器，在底部快捷导航切换常用页面，也可以通过搜索查找功能。入口端口、目标地址和规则状态都能在手机上查看与修改。</p></details>
            </div>
          </div>
        </section>
        <section className="public-cta-band" aria-labelledby="home-cta">
          <div className="public-home-container public-cta-inner">
            <h2 id="home-cta">准备好了？<br /><span className="public-gradient-text">从一条路径开始。</span></h2>
            <p>登录 {siteTitle}，把主机、线路与转发放进同一个工作空间。</p>
            <div className="public-hero-actions is-center">
              <Button size="lg" asChild className="public-cta"><Link href={primaryHref}>{primaryLabel}<ArrowRight size={16} aria-hidden="true" /></Link></Button>
              <Button size="lg" variant="outline" asChild className="public-cta"><a href={docsHomeUrl}>阅读文档</a></Button>
            </div>
          </div>
        </section>
      </main>
      <footer className="public-footer">
        <div className="public-home-container public-footer-grid">
          <div className="public-footer-brand">
            <Link href="/" className="public-home-brand"><img src={logoSrc} alt="" /><span>{siteTitle}</span></Link>
            <p>网络转发工作空间：主机、线路、规则与用量，一处掌握。</p>
          </div>
          <nav aria-label="页脚导航" className="public-footer-links">
            <a href="#features">功能</a>
            <a href="#getting-started">如何开始</a>
            <a href={docsHomeUrl}>使用文档</a>
            {repoUrl && <a href={repoUrl} target="_blank" rel="noopener noreferrer">GitHub</a>}
            <Link href="/login">登录</Link>
          </nav>
        </div>
        <div className="public-home-container public-footer-legal">
          <span>{siteTitle}{version ? ` · v${version}` : ""}</span>
          <span>Powered by NEX</span>
        </div>
      </footer>
    </div>
  );
}

export default function PublicHome() {
  const { resolvedTheme, setTheme } = useTheme();
  const { data: info } = trpc.system.publicInfo.useQuery(undefined, { refetchOnWindowFocus: false });
  return <PublicHomeView
    siteTitle={resolveSiteTitle(info?.siteTitle)}
    logoSrc={info?.siteLogoDataUrl || (resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png")}
    version={info?.version} repoUrl={info?.repoUrl}
    registrationEnabled={info ? info.registrationEnabled !== false : undefined}
    dark={resolvedTheme === "dark"} onToggleTheme={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
  />;
}
