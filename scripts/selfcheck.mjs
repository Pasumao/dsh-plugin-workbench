// 最小自检：发布前验证结构完整（离线、零依赖）。node scripts/selfcheck.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const pkgPath = join(root, "package.json");
if (!existsSync(pkgPath)) failures.push("缺 package.json");
else {
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); }
  catch { failures.push("package.json 解析失败"); pkg = {}; }
  if (pkg.name && pkg.main && !existsSync(join(root, pkg.main)))
    failures.push(`入口不存在: ${pkg.main}`);
  if (pkg.dsh?.bundle?.patch && !existsSync(join(root, pkg.dsh.bundle.patch)))
    failures.push(`bundle patch 不存在: ${pkg.dsh.bundle.patch}`);
}

for (const f of ["README.md", "LICENSE"]) {
  if (!existsSync(join(root, f))) failures.push(`缺 ${f}`);
}

if (failures.length) {
  for (const f of failures) console.error(`[FAIL] ${f}`);
  console.error(`${failures.length} 项失败`);
  process.exit(1);
}
console.log("[PASS] 结构完整，可发布");
