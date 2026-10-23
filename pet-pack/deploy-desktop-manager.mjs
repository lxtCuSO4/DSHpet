#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { spawnSync } from "node:child_process";
import { patchHelper, patchHost } from "./desktop-manager-patch.mjs";
const argv = process.argv.slice(2),
  arg = (key) => {
    const i = argv.indexOf("--" + key);
    return i >= 0 ? argv[i + 1] : "";
  };
if (!arg("source") || !arg("target") || !arg("backup"))
  throw Error(
    "用法：node deploy-desktop-manager.mjs --source <源码 helper> --target <目标 helper> --backup <本地备份> [--patch-host] [--apply]",
  );
const source = realpathSync(resolve(arg("source"))),
  target = realpathSync(resolve(arg("target"))),
  backup = resolve(arg("backup"));
const additions = [
  "manager-policy.js",
  "manager-store.js",
  "manager-controller.js",
  "manager-shell.js",
  "manager-preload.js",
  "manager.html",
  "manager.css",
  "manager-page.js",
  "fullscreen-observer.js",
  "fullscreen-probe.ps1",
];
const changes = [];
const hash = (data) => createHash("sha256").update(data).digest("hex");
for (const name of ["main.js", "preload.js", "sprite.js", ...additions]) {
  const dest = join(target, name),
    old = existsSync(dest) ? readFileSync(dest) : null;
  const content = additions.includes(name)
    ? readFileSync(join(source, name))
    : Buffer.from(patchHelper(name, old.toString("utf8")));
  if (name.endsWith(".js"))
    new Script(content.toString("utf8"), { filename: name });
  if (old?.equals(content)) continue;
  changes.push({
    name,
    dest,
    old,
    content,
    before: old ? hash(old) : null,
    after: hash(content),
  });
}
if (argv.includes("--patch-host")) {
  const dest = resolve(target, "../../lib/index.js"),
    old = readFileSync(dest),
    content = Buffer.from(patchHost(old.toString("utf8")));
  const check = spawnSync(
    process.execPath,
    ["--input-type=module", "--check"],
    { input: content, encoding: "utf8" },
  );
  if (check.status !== 0) throw Error("宿主补丁语法检查失败：" + check.stderr);
  if (!old.equals(content))
    changes.push({
      name: "host-index.js",
      dest,
      old,
      content,
      before: hash(old),
      after: hash(content),
    });
}
if (argv.includes("--apply")) {
  mkdirSync(backup, { recursive: true });
  // Save every original before changing any destination; existing backups are never overwritten.
  for (const change of changes)
    if (change.old)
      writeFileSync(
        join(backup, change.name + "." + change.before + ".bak"),
        change.old,
        { flag: "wx" },
      );
  writeFileSync(
    join(backup, "manifest-" + randomUUID() + ".json"),
    JSON.stringify(
      changes.map(({ name, before, after }) => ({ name, before, after })),
      null,
      2,
    ),
  );
  for (const change of changes) {
    if (!change.old && existsSync(change.dest))
      throw Error("新增目标已被其它程序创建：" + change.name);
    if (change.old && hash(readFileSync(change.dest)) !== change.before)
      throw Error("目标文件在备份后变化：" + change.name);
    const temp = change.dest + "." + randomUUID() + ".tmp";
    mkdirSync(dirname(temp), { recursive: true });
    writeFileSync(temp, change.content, { flag: "wx" });
    renameSync(temp, change.dest);
    if (hash(readFileSync(change.dest)) !== change.after)
      throw Error("部署文件校验失败：" + change.name);
  }
}
console.log(
  JSON.stringify(
    {
      applied: argv.includes("--apply"),
      source,
      target,
      files: changes.map(({ name, before, after }) => ({
        name,
        before,
        after,
      })),
    },
    null,
    2,
  ),
);
