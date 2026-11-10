import { col, type TableDef } from "./tableDefs";

/*
  ui_theme_packages：装在这个面板上的界面主题包（设置 › 个性化 › 主题管理，见 shared/uiThemePackage.ts）。

  一行一套。css 是已经检查、内联过资源的那一份（server/uiThemePackage.ts 的 compileUiThemeCss），
  直接从 /api/ui-themes/<themeId>.css 下发；大的主题带着内联的图片和字体，所以用 LONGTEXT。
  revision 是清单 + 样式的 sha256，样式地址带着它做缓存键。
  不单独存压缩包原件：要导出时用清单和样式现打一个包（资源已经在样式里了）。
*/
export const uiThemesTables: TableDef[] = [
  {
    name: "ui_theme_packages",
    columns: [
      col("id", "id"),
      col("themeId", "varchar", { length: 64, notNull: true }),
      col("name", "varchar", { length: 80, notNull: true }),
      col("version", "varchar", { length: 64, notNull: true }),
      col("revision", "varchar", { length: 64, notNull: true }),
      // official（官方主题库）/ upload（上传的压缩包）/ url（从链接安装）
      col("source", "varchar", { length: 16, notNull: true, default: "upload" }),
      col("sourceUrl", "text"),
      col("manifestJson", "longtext"),
      col("css", "longtext"),
      col("installedAt", "epoch", { notNull: true, default: "now" }),
      col("updatedAt", "epoch", { notNull: true, default: "now" }),
    ],
    unique: [["themeId"]],
  },
];

/** 装了哪些主题是站点配置的一部分：备份 / 迁移带着走，不然换了面板站点默认主题就找不到样式了。 */
export const uiThemesMigrationTables: string[] = ["ui_theme_packages"];
