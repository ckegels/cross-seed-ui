import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const HUB = process.env.CSUI_HUB ?? "http://127.0.0.1:2470";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		sourcemap: false,
		chunkSizeWarningLimit: 900,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: HUB,
				changeOrigin: true,
				// the hub checks Origin against Host; drop it for the dev proxy
				configure: (proxy) => {
					proxy.on("proxyReq", (req) => req.removeHeader("origin"));
				},
			},
		},
	},
});
