/*
  2.3.550 起壁纸（client/public/wallpapers）和地球贴图（client/public/globe 的星空、地形）改成 WebP，
  体积少六成多。老版本的手机 App、浏览器缓存里的旧页面还会按旧文件名要 .jpg / .png，
  这里给出同名 .webp 的跳转目标；还是原格式的（earth-dark.jpg、earth-night.jpg）不跳。
*/
const CONVERTED: Record<string, ReadonlySet<string>> = {
  wallpapers: new Set(["anime-1", "anime-2", "anime-3", "anime-4", "illustration-1"]),
  globe: new Set(["night-sky", "earth-topology"]),
};

export function legacyImageRedirectTarget(requestPath: string): string | null {
  const match = /^\/(wallpapers|globe)\/([A-Za-z0-9_-]+)\.(?:jpg|jpeg|png)$/.exec(requestPath);
  if (!match) return null;
  const [, directory, name] = match;
  if (!CONVERTED[directory]?.has(name)) return null;
  return `/${directory}/${name}.webp`;
}
