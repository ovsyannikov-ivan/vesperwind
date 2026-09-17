import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

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
});
