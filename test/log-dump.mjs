// 把样本渲染成人眼可读的日志打出来,用来核对"是否真的像游戏日志"。
// 只是开发时的目视工具,不做断言,不进 npm test。
import { loadPGLog, SAMPLES } from "./log-render.mjs";

const { PGLog } = loadPGLog();
const MARK = { ok: "+", bad: "x", warn: "!", head: "#", muted: " " };

for (const [key, data] of Object.entries(SAMPLES)) {
  console.log(`==== ${PGLog.label(key)} (${key}) ====`);
  for (const l of PGLog.lines(data, key)) {
    console.log("  ".repeat(l.i || 0) + (MARK[l.k] ?? " ") + " " + l.t);
  }
  console.log(`一行摘要 → ${PGLog.oneLine(data, key)}`);
  console.log("");
}
