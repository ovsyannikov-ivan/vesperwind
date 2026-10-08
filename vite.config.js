import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import fs from "node:fs/promises";

const ignoredClientDirectivePackages = ["/node_modules/@radix-ui/", "/node_modules/cmdk/", "/node_modules/sonner/"];

const ignoreClientDirectiveWarning = (warning) => warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes('"use client"') && ignoredClientDirectivePackages.some((path) => warning.id?.includes(path));

export default defineConfig({
	worker: { format: "es" },
	plugins: [
		{
			name: "vesperwind-editor-notices",
			async generateBundle() {
				const directory = new URL("./src/editor/themes/licenses/", import.meta.url);
				for (const name of await fs.readdir(directory)) {
					this.emitFile({ type: "asset", fileName: `editor-notices/${name}`, source: await fs.readFile(new URL(name, directory), "utf8") });
				}
				this.emitFile({ type: "asset", fileName: "editor-notices/THIRD-PARTY-NOTICES.md", source: await fs.readFile(new URL("./src/editor/themes/THIRD-PARTY-NOTICES.md", import.meta.url), "utf8") });
			},
		},
		vue({
			template: {
				compilerOptions: {
					isCustomElement: (tag) => tag.startsWith("media-"),
				},
			},
		}),
	],
	css: {
		preprocessorOptions: {
			scss: {
				loadPaths: [fileURLToPath(new URL("./src/styles", import.meta.url))],
			},
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		watch: {
			ignored: ["**/dist/**", "**/staging/**", "**/src-tauri/target/**"],
		},
		proxy: {
			"/api": {
				target: "http://127.0.0.1:3001",
			},
			"/socket.io": {
				target: "http://127.0.0.1:3001",
				ws: true,
			},
		},
	},
	build: {
		rollupOptions: {
			onwarn(warning, warn) {
				if (ignoreClientDirectiveWarning(warning)) return;
				warn(warning);
			},

			input: {
				main: fileURLToPath(new URL("./index.html", import.meta.url)),
				mediaOverlay: fileURLToPath(new URL("./media-overlay.html", import.meta.url)),
			},
		},
	},
});
