import { spawnSync } from "node:child_process";

const result = spawnSync(
  "git",
  [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "dist",
    "package-lock.json"
  ],
  { encoding: "utf8" }
);

if (result.status !== 0) {
  throw new Error(`git status failed:\n${result.stderr}`);
}

if (result.stdout.trim().length > 0) {
  throw new Error(
    `Generated package artifacts are not synchronized:\n${result.stdout}`
  );
}
