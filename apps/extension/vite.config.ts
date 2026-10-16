import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  cpSync,
  mkdirSync,
  renameSync,
  createReadStream,
} from "node:fs";
const root = resolve("apps/extension");
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const apiUrl = env.VITE_ROSETTATAB_API_URL || "";
  const server = apiUrl ? new URL(apiUrl) : undefined;
  let buildDirectory = resolve("dist/extension");
  if (
    server &&
    (server.username ||
      server.password ||
      server.search ||
      server.hash ||
      server.pathname !== "/" ||
      !(
        server.protocol === "https:" ||
        (env.VITE_ROSETTATAB_ALLOW_LOCAL_API === "1" &&
          server.origin === "http://127.0.0.1:8787")
      ))
  )
    throw new Error(
      "VITE_ROSETTATAB_API_URL must be blank or a plain HTTPS origin. Loopback is available only with explicit VITE_ROSETTATAB_ALLOW_LOCAL_API=1 for operator development.",
    );
  return {
    root,
    envDir: process.cwd(),
    base: "./",
    define: {
      __ROTAB_BUNDLED_TURN__: "null",
      "import.meta.env.ROTAB_SEARCH_PROVIDER_PICKER": "true",
    },
    plugins: [
      react(),
      {
        name: "extension-resources",
        configResolved(config) {
          buildDirectory = resolve(config.build.outDir);
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const file = request.url
              ?.split("?")[0]
              ?.match(
                /^\/engine\/(engine-metadata\.json|rosetta\.(mjs|wasm|data))$/,
              )?.[1];
            const path =
              file &&
              resolve(
                "engine/artifacts/verified",
                file === "engine-metadata.json" ? "manifest.json" : file,
              );
            if (!path || !existsSync(path)) return next();
            response.setHeader(
              "Content-Type",
              file!.endsWith(".wasm")
                ? "application/wasm"
                : file!.endsWith(".mjs")
                  ? "application/javascript"
                  : file!.endsWith(".json")
                    ? "application/json"
                    : "application/octet-stream",
            );
            createReadStream(path).pipe(response);
          });
        },
        closeBundle() {
          const dist = buildDirectory;
          mkdirSync(dist, { recursive: true });
          const manifest = JSON.parse(
            readFileSync(resolve(root, "public/manifest.json"), "utf8"),
          );
          delete manifest.key;
          manifest.host_permissions = [
            ...(server ? [server.origin + "/*"] : []),
            ...manifest.host_permissions.filter(
              (p: string) => !p.startsWith("http://127.0.0.1:8787"),
            ),
          ];
          writeFileSync(
            resolve(dist, "manifest.json"),
            JSON.stringify(manifest, null, 2) + "\n",
          );
          cpSync(
            resolve(root, "src/background.js"),
            resolve(dist, "background.js"),
          );
          if (existsSync("engine/artifacts/verified/manifest.json"))
            cpSync("engine/artifacts/verified", resolve(dist, "engine"), {
              recursive: true,
            });
          if (existsSync(resolve(dist, "engine/manifest.json")))
            renameSync(
              resolve(dist, "engine/manifest.json"),
              resolve(dist, "engine/engine-metadata.json"),
            );
          if (manifest.manifest_version !== 3)
            throw new Error("Expected Manifest V3.");
        },
      },
    ],
    build: {
      outDir: buildDirectory,
      emptyOutDir: true,
      target: "es2022",
      chunkSizeWarningLimit: 3000,
    },
    server: { port: 5173, strictPort: true },
    worker: { format: "es" },
  };
});
