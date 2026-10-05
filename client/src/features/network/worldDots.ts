/**
 * 首页「概览」底下那层世界剪影的点阵：陆地按 2° 网格采样（奇数行错开 1°，排成蜂窝状），
 * 由 Natural Earth 110m 陆地轮廓离线生成（scripts 里没有生成器，改分辨率要重新算一遍）。
 *
 * 编码：行用 ; 分开，第 r 行的纬度 = 74 - r × 2；一行里的每一段是「起始列[-长度]」（36 进制），
 * 第 c 列的经度 = -180 + c × 2（奇数行再 + 1）。解出来是 [经度, 纬度] 列表，3619 个点。
 */
const STEP = 2;
const LAT_TOP = 74;
const DATA = "s-4,17-2,1q-i,3a-2,3q-c;r-3,v-7,14-2,19-8,1q-g,38-2,3g-2,3j-3,3n-n,4g-5;9-a,p-2,w-8,15-4,1c-9,1r-g,2t-5,3g-1a;1-2p,32-2,35-2;6-2j,30-3;a-z,1b,1d,1i-3,1s-6,27-3,2n-5,2t-7,31-1y;8-10,1e-4,1u-3,2l-6,2t-1z,4t-5;8-8,j-o,1f-4,1l,2l-6,2t,2x-1q,4r-2;c,n-l,1g-7,2g,2o-3,2v-1m,4p-3;a,o-m,1g-8,2f,2m,2o,2t-1m,4o-3;o-p,1f-b,2e,2h,2n-2,2q-1p,4g,4o-3;q-n,1f-b,2d,2f-4,2k-1y,4o;q-v,1q,2j-1y,4i;t-s,1o-4,2g-20;t-u,1o,2i-g,2z,31-6,39-16;s-r,1l,2h-5,2n,2q-6,32-4,37-17,4h-2;s-s,2e-6,2o-2,2s-4,2z,33-4,39-13,4g;s-p,2d-5,2m,2s,2v-c,39-x,47-3,4g;t-n,2e-4,2p-2,2t-2,2w-b,39-x,49-2,4g;t-n,2i-5,30-16,49-2,4e-2;v-l,2f-9,30-17,4c-3;w-i,2d-d,2s-2,2z-18,4b;y-c,1d,2e-t,38-z;x-9,1d,2c-n,30-6,38-z;y,10-6,2b-p,31-7,3b-v;10-5,2a-q,31-a,3g-p,46;12-4,1c,1e-2,2a-r,32-a,3h-m;11-5,19,1f-2,2a-r,32-9,3i-7,3s-7;13-7,1l,2a-s,33-8,3j-5,3u-6,47;15,17-3,2a-s,33-5,3j-3,3t,3v-5,46;19-4,2a-t,34-3,3k-3,3w-5,47;1b,2a-u,37,3k-2,3v,3x-4,48;1c,1h-6,2b-x,3l,3z;1d,1f-9,2b-w,3m,3v,47-2;1g-a,2d-6,2l-m,3x;1f-d,2m-k,3u,3w-2,43-2;1f-e,2n-i,3w,3y,42-3;1e-f,2n-g,3w-2,41-4;1e-i,2n-g,3x-2,42-3,46,4d,4f;1d-m,2o-e,3x-2,43,4c-6,4m;1e-n,2p-d,3z,4g-4,4l;1e-n,2p-d,41-2,4f-3,4j,4p;1f-m,2p-d,46,48,4k-2;1f-k,2p-d,4c,4h;1g-j,2p-e,36-2,4b-3,4h;1h-i,2o-e,35-2,48-7,4h-2;1j-g,2o-d,35-2,48-c,4z;1j-f,2o-b,34-2,46-e;1j-f,2q-a,34-3,44-h,4t;1j-c,2p-b,34-2,43-j;1j-b,2q-9,43-k;1i-c,2q-8,43-k;1j-a,2r-7,44-j;1i-a,2r-6,44-6,4c-a;1j-9,2s-2,44-2,4e-8;1i-7,4g-5;1i-8,4h-3,4y-2;1h-6,4x;1h-5,4j-2,4w-2;1h-4,4u-2;1h-4,4u-2;1g-5;1h-3;1g-4,1n-2;1i-3;";

let cache: ReadonlyArray<readonly [number, number]> | null = null;

/** 全部陆地点（第一次调用时解码，之后复用） */
export function worldDots(): ReadonlyArray<readonly [number, number]> {
  if (cache) return cache;
  const out: Array<readonly [number, number]> = [];
  DATA.split(";").forEach((row, r) => {
    if (!row) return;
    const lat = LAT_TOP - r * STEP;
    const offset = r % 2 ? STEP / 2 : 0;
    for (const run of row.split(",")) {
      const [startText, lenText] = run.split("-");
      const start = parseInt(startText, 36);
      const len = lenText ? parseInt(lenText, 36) : 1;
      for (let c = start; c < start + len; c += 1) out.push([-180 + c * STEP + offset, lat]);
    }
  });
  cache = out;
  return out;
}
