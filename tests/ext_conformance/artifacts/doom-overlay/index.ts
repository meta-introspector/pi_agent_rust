/**
 * DOOM Overlay Demo - Play DOOM as an overlay
 *
 * Usage: pi --extension ./examples/extensions/doom-overlay
 *
 * Commands:
 *   /doom-overlay - Play DOOM in an overlay (Q to pause/exit)
 *
 * This demonstrates that overlays can handle real-time game rendering at 35 FPS.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { DoomOverlayComponent } from "./doom-component.js";
import { DoomEngine } from "./doom-engine.js";
import { ensureWadFile } from "./wad-finder.js";

const DEBUG_LOG_PATH = "/data/projects/pi_agent_rust/tests/ext_conformance/artifacts/doom-overlay/doom-debug.log";

function debugLog(message: string): void {
	appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} index ${message}\n`);
}

async function yieldToUi(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

// Persistent engine instance - survives between invocations
let activeEngine: DoomEngine | null = null;
let activeWadPath: string | null = null;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("doom-overlay", {
		description: "Play DOOM as an overlay. Q to pause and exit.",

		handler: async (args, ctx) => {
			debugLog("handler:start");
			if (!ctx.hasUI) {
				debugLog("handler:no-ui");
				ctx.ui.notify("DOOM requires interactive mode", "error");
				return;
			}

			// Auto-download WAD if not present
			ctx.ui.notify("Loading DOOM TEST...", "info");
			const wad = args?.trim()
				? args.trim()
				: await ensureWadFile((message) => ctx.ui.notify(message, "info"));
			debugLog(`handler:wad=${wad ?? "<null>"}`);
			ctx.ui.notify("After WAD resolution...", "info");
			await yieldToUi();

			if (!wad) {
				debugLog("handler:wad-missing");
				ctx.ui.notify("Failed to download DOOM WAD file. Check your internet connection.", "error");
				return;
			}

			try {
				debugLog("handler:enter-try");
				// Reuse existing engine if same WAD, otherwise create new
				let isResume = false;
				if (activeEngine && activeWadPath === wad) {
					debugLog("handler:resume-engine");
					ctx.ui.notify("Resuming DOOM...", "info");
					await yieldToUi();
					isResume = true;
				} else {
					debugLog("handler:before-load-notify");
					ctx.ui.notify(`Loading DOOM from ${wad}...`, "info");
					await yieldToUi();
					debugLog("handler:after-load-notify");
					ctx.ui.notify("Creating DOOM engine...", "info");
					await yieldToUi();
					debugLog("handler:after-create-notify");
					activeEngine = new DoomEngine(wad, (message) => ctx.ui.notify(message, "info"));
					debugLog("handler:engine-constructed");
					ctx.ui.notify("Initializing DOOM engine...", "info");
					await yieldToUi();
					debugLog("handler:before-init");
					await activeEngine.init();
					debugLog("handler:after-init");
					ctx.ui.notify("DOOM engine initialized.", "info");
					activeWadPath = wad;
				}

				debugLog("handler:before-overlay");
				ctx.ui.notify("Opening DOOM overlay...", "info");
				await ctx.ui.custom(
					(tui, _theme, _keybindings, done) => {
						debugLog("handler:overlay-factory");
						return new DoomOverlayComponent(tui, activeEngine!, () => done(undefined), isResume);
					},
					{
						overlay: true,
						overlayOptions: {
							width: "75%",
							maxHeight: "95%",
							anchor: "center",
							margin: { top: 1 },
						},
					},
				);
				debugLog("handler:overlay-closed");
			} catch (error) {
				debugLog(`handler:error=${String(error)}`);
				ctx.ui.notify(`Failed to load DOOM: ${error}`, "error");
				activeEngine = null;
				activeWadPath = null;
			}
		},
	});
}
