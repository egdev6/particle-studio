import { readdirSync, existsSync, statSync } from "node:fs";
const targets = [
  "/app/node_modules/@playwright",
  "/app/node_modules/react",
  "/app/node_modules/react-dom",
  "/app/node_modules/@testing-library",
  "/app/node_modules/@vitejs",
  "/app/node_modules/@sinclair",
  "/app/node_modules/@types",
  "/app/node_modules/vitest",
  "/app/node_modules/typescript",
  "/app/node_modules/vite",
  "/app/node_modules/jsdom",
  "/app/node_modules/rolldown",
];
const out = {};
for (const t of targets) {
  if (!existsSync(t)) { out[t] = null; continue; }
  const s = statSync(t);
  out[t] = { isDirectory: s.isDirectory(), entries: readdirSync(t) };
}
console.log(JSON.stringify(out, null, 2));
