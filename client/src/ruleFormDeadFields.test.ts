import assert from "node:assert/strict";
import test from "node:test";
import { readRulesPageSource } from "./testing/rulesPageSource";

/**
 * 「创建转发」这张表单里不许有只写不读的字段。
 *
 * 写这条时 RuleFormData 有 32 个字段，而**其中 15 个谁也没读过**：
 *
 *   gostMode / gostRelayHost / gostRelayPort
 *   blockHttp / blockSocks / blockTls
 *   proxyProtocolReceive / Send / ExitReceive / ExitSend / Version
 *   tcpFastOpen / zeroCopy / udpOverTcp / udpOverTcpPort
 *
 * 它们在 defaultForm 里有初值、openEdit 里从规则读回来、提交时却一个都不带，对话框里
 * 也没有任何控件能改它们。真正改这些开关的地方在隧道页和主机页。
 *
 * 这种死字段不是「多几行没关系」：
 *
 *   · 读代码的人会以为这张表单管着它们，于是去改这里 —— 改完没有任何效果。
 *   · openEdit 里那句 `blockHttp: false` 看上去像是「编辑规则会清掉协议封禁」，
 *     查清楚它其实无害花了不少时间（服务端根本不收这个字段，生效的是主机那一层）。
 *   · 这张表单是 item 十七「创建转发极简」要动的地方。32 个字段和 17 个字段，
 *     看到的复杂度完全不是一回事。
 *
 * 所以这条盯的是一个会反复发生的情况：给规则加了个新开关，后来那条路改走别处了，
 * 开关留在表单里没人删。下次再发生时这里会红。
 */

// 规则页在渐进拆分（RulesContent 的片段搬进 features/rules/use*.ts(x)），读页面要连 hook 一起读

/*
  确实需要留在表单里、但不会以 form.X 形式被读的字段写在这里，一个都没有。

  留空是故意的：真遇到那种字段时，加进来的人得在这里写清楚它为什么读不到 ——
  而不是顺手把断言放宽。
*/
const KNOWN_WRITE_ONLY_FIELDS: string[] = [];

function ruleFormFields(source: string): string[] {
  const body = /type RuleFormData = \{(.*?)\n\};/s.exec(source);
  assert.ok(body, "找不到 RuleFormData 的定义 —— 这条测试锚错了地方");
  return Array.from(body[1].matchAll(/^\s*(\w+)\s*\??:/gm)).map((match) => match[1]);
}

test("创建转发的表单字段，每一个都得有人读", () => {
  const source = readRulesPageSource();
  const fields = ruleFormFields(source);

  // 锚点校验：解析不出字段就说明正则失配了，那下面的断言会全部空转。
  assert.ok(fields.length >= 12, `只解析出 ${fields.length} 个字段，正则大概失配了`);
  assert.ok(fields.includes("sourcePort") && fields.includes("targetIp"),
    `解析出来的字段不对劲：${fields.join(", ")}`);

  const deadFields = fields.filter((field) => {
    if (KNOWN_WRITE_ONLY_FIELDS.includes(field)) return false;
    return !new RegExp(`\\bform\\.${field}\\b`).test(source);
  });

  assert.deepEqual(
    deadFields,
    [],
    `这些字段在表单里只写不读：${deadFields.join("、")}。\n`
      + "要么把它接上（加个控件、或者提交时带上），要么从 RuleFormData 里删掉。\n"
      + "留着的话，下一个读这段代码的人会以为改它有用。",
  );
});

/*
  允许写死星号的标签：这些字段在 shared/forwardRuleForm 里是**无条件**必填的，
  任何路由模式、新建还是编辑都一样，写死不会和拦截逻辑说反话。

  源端口不在这里 —— 它只有编辑时才必填，所以必须跟着判断走。
*/
const ALWAYS_REQUIRED_LABELS = ["目标地址", "目标端口"];

test("必填标记必须来自判断本身，不许手写", () => {
  /*
    源端口的红星曾经是硬编码的，而它说的和拦截逻辑正好相反：新建时留空（0）本来
    合法 —— 面板会随机分配。用户照着红星去猜一个号，撞上占用，再猜一个，而这个
    字段他本来可以完全不管。

    这条盯两件事：源端口的星号还跟着判断走；以及没有人又往别的标签上写死一个星号
    而不说明理由。
  */
  const source = readRulesPageSource();
  const dialog = /<DialogTitle>\{editingId \? "编辑规则"[\s\S]*?<\/DialogFooter>/.exec(source);
  assert.ok(dialog, "找不到新建/编辑转发的对话框 —— 这条测试锚错了地方");

  assert.match(
    dialog[0],
    /sourcePortRequired\s*\n?\s*\?\s*<span className="text-destructive">\*<\/span>/,
    "源端口的必填标记不再跟着 isForwardRuleSourcePortRequired 走了。"
      + "写死的话，新建时它会说「必填」，而留空其实完全合法。",
  );

  const hardcoded = dialog[0].split("\n")
    .filter((line) => /<Label/.test(line) && /text-destructive">\*/.test(line))
    .filter((line) => !ALWAYS_REQUIRED_LABELS.some((label) => line.includes(label)));
  assert.deepEqual(
    hardcoded,
    [],
    "这些标签里写死了必填星号，而它们不在「无条件必填」名单里：\n" + hardcoded.join("\n")
      + "\n要么让星号跟着 shared/forwardRuleForm 的判断走，要么把字段加进"
      + " ALWAYS_REQUIRED_LABELS 并说明它为什么永远必填。",
  );
});

test("表单字段数守住上限，别再长回去", () => {
  /*
    这是个棘轮，不是硬性设计约束。清理之后是 17，现在 22。

    涨上去的三个全部属于主备线路，而主备线路默认是关的、又折在「更多设置」里，
    第一屏一个都看不到：

      · failoverProbeTarget —— 主线路的健康探测目标。不填的话，中转用 gost/realm
        这类用户态转发时健康检查只能探到中转本身，中转的上游断了主备不会切，
        而面板上一切正常。
      · failoverSchedule —— 时段表（晚高峰错峰）。
      · failoverMinHoldSeconds —— 最短驻留，防止线路来回抖。
      · failoverPin —— 人工钉住某一条出站，带期限。它本可以拆成两个字段（走哪条、
        钉到什么时候），但那是一件事的两半：单独存一个「钉到什么时候」而不说钉的是
        哪条，没有任何意义。合成一个就是这个考虑。

    这三个是同一件事的三个面，不是三次随手添加。再往上涨之前先想清楚：能不能用
    已有的字段表达，或者干脆不做。

    「创建转发极简」要往下走，这个数只该降不该涨。真需要加字段时改这个数，改的
    时候顺便想想能不能不加 —— 这正是这条想制造的那一下停顿。上面这段就是那次
    停顿的结果。
  */
  const fields = ruleFormFields(readRulesPageSource());
  assert.ok(
    fields.length <= 22,
    `创建转发的表单涨到了 ${fields.length} 个字段（上限 22）。`
      + "每多一个字段，用户就多一次「这是什么、我要不要动它」。",
  );
});
