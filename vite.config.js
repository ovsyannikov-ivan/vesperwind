import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

const ignoredClientDirectivePackages = ["/node_modules/@radix-ui/", "/node_modules/cmdk/", "/node_modules/sonner/"];

const ignoreClientDirectiveWarning = (warning) => warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes('"use client"') && ignoredClientDirectivePackages.some((path) => warning.id?.includes(path));

export default defineConfig({
	plugins: [
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
