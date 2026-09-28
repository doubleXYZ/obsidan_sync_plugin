import esbuild from "esbuild";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import builtins from "builtin-modules";

const isProduction = process.argv[2] === "production";
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const context = await esbuild.context({
  entryPoints: [path.join(projectRoot, "src/main.ts")],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: isProduction ? false : "inline",
  treeShaking: true,
  outfile: path.join(projectRoot, "main.js"),
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Watching for changes...");
}