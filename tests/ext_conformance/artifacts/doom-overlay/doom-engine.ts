/**
 * DOOM Engine - WebAssembly wrapper for doomgeneric
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DoomModule {
	_doomgeneric_Create: (argc: number, argv: number) => void;
	_doomgeneric_Tick: () => void;
	_DG_GetFrameBuffer: () => number;
	_DG_GetScreenWidth: () => number;
	_DG_GetScreenHeight: () => number;
	_DG_PushKeyEvent: (pressed: number, key: number) => void;
	_malloc: (size: number) => number;
	_free: (ptr: number) => void;
	HEAPU8: Uint8Array;
	HEAPU32: Uint32Array;
	FS_createDataFile: (parent: string, name: string, data: number[], canRead: boolean, canWrite: boolean) => void;
	FS_createPath: (parent: string, path: string, canRead: boolean, canWrite: boolean) => string;
	setValue: (ptr: number, value: number, type: string) => void;
	getValue: (ptr: number, type: string) => number;
}

export class DoomEngine {
	private module: DoomModule | null = null;
	private frameBufferPtr: number = 0;
	private initialized = false;
	private wadPath: string;
	private _width = 640;
	private _height = 400;
	private progress?: (message: string) => void;

	constructor(wadPath: string, progress?: (message: string) => void) {
		this.wadPath = wadPath;
		this.progress = progress;
		this.debug(`constructor wad=${wadPath}`);
	}

	private debug(message: string): void {
		const now = new Date().toISOString();
		appendFileSync(
			"/data/projects/pi_agent_rust/tests/ext_conformance/artifacts/doom-overlay/doom-debug.log",
			`${now} engine ${message}\n`,
		);
	}

	get width(): number {
		return this._width;
	}

	get height(): number {
		return this._height;
	}

	private async yieldAfterProgress(message: string): Promise<void> {
		this.progress?.(message);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	async init(): Promise<void> {
		this.debug("init:start");
		await this.yieldAfterProgress("DOOM init: locating WASM build...");
		// Locate WASM build
		const __dirname = dirname(fileURLToPath(import.meta.url));
		const buildDir = join(__dirname, "doom", "build");
		const doomJsPath = join(buildDir, "doom.js");

		if (!existsSync(doomJsPath)) {
			this.debug(`init:missing-js=${doomJsPath}`);
			throw new Error(`WASM not found at ${doomJsPath}. Run ./doom/build.sh first`);
		}

		await this.yieldAfterProgress("DOOM init: reading WAD file...");
		// Read WAD file
		const wadData = readFileSync(this.wadPath);
		const wadArray = Array.from(new Uint8Array(wadData));
		this.debug(`init:wad-bytes=${wadArray.length}`);
		await this.yieldAfterProgress(`DOOM init: WAD loaded (${wadArray.length} bytes)`);

		await this.yieldAfterProgress("DOOM init: loading generated JS glue...");
		// Load WASM module - eval to bypass jiti completely
		const doomJsCode = readFileSync(doomJsPath, "utf-8");
		this.debug(`init:js-bytes=${doomJsCode.length}`);
		const moduleExports: { exports: unknown } = { exports: {} };
		const nativeRequire = createRequire(doomJsPath);
		const wasmDebug: string[] = [];
		const originalCompile = WebAssembly.compile.bind(WebAssembly);
		const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
		let wasmCallSeq = 0;
		(WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = async (source) => {
			const callId = ++wasmCallSeq;
			const start = Date.now();
			this.progress?.(`DOOM init: wasm compile #${callId} start`);
			wasmDebug.push(`compile#${callId}:start`);
			try {
				const result = await originalCompile(source);
				this.progress?.(`DOOM init: wasm compile #${callId} done in ${Date.now() - start}ms`);
				wasmDebug.push(`compile#${callId}:done:${Date.now() - start}ms`);
				return result;
			} catch (error) {
				this.progress?.(`DOOM init: wasm compile #${callId} failed: ${String(error)}`);
				wasmDebug.push(`compile#${callId}:fail:${String(error)}`);
				throw error;
			}
		};
		(
			WebAssembly as unknown as {
				instantiate: typeof WebAssembly.instantiate;
			}
		).instantiate = async (source, imports) => {
			const callId = ++wasmCallSeq;
			const sourceKind =
				typeof source === "object" && source && "__wasm_module_id" in (source as object)
					? "module"
					: "bytes";
			const start = Date.now();
			this.progress?.(`DOOM init: wasm instantiate #${callId} start (${sourceKind})`);
			wasmDebug.push(`instantiate#${callId}:start:${sourceKind}`);
			try {
				const result = await originalInstantiate(source, imports);
				this.progress?.(`DOOM init: wasm instantiate #${callId} done in ${Date.now() - start}ms`);
				wasmDebug.push(`instantiate#${callId}:done:${Date.now() - start}ms`);
				return result;
			} catch (error) {
				this.progress?.(`DOOM init: wasm instantiate #${callId} failed: ${String(error)}`);
				wasmDebug.push(`instantiate#${callId}:fail:${String(error)}`);
				throw error;
			}
		};
		const moduleFunc = new Function("module", "exports", "__dirname", "__filename", "require", doomJsCode);
		this.debug("init:module-func-created");
		moduleFunc(moduleExports, moduleExports.exports, buildDir, doomJsPath, nativeRequire);
		this.debug("init:module-func-ran");
		const createDoomModule = moduleExports.exports as (config: unknown) => Promise<DoomModule>;
		await this.yieldAfterProgress("DOOM init: JS glue loaded, instantiating module...");

		const moduleConfig = {
			locateFile: (path: string) => {
				if (path.endsWith(".wasm")) {
					return join(buildDir, path);
				}
				return path;
			},
			print: () => {},
			printErr: () => {},
			preRun: [
				(module: DoomModule) => {
					// Create /doom directory and add WAD
					module.FS_createPath("/", "doom", true, true);
					module.FS_createDataFile("/doom", "doom1.wad", wadArray, true, false);
				},
			],
		};

		try {
			const initStart = Date.now();
			await this.yieldAfterProgress("DOOM init: calling createDoomModule...");
			this.debug("init:before-createDoomModule");
			const modulePromise = createDoomModule(moduleConfig);
			this.debug("init:after-createDoomModule-call");
			await this.yieldAfterProgress("DOOM init: createDoomModule returned.");
			const moduleOrTimeout = await Promise.race([
				modulePromise,
				new Promise<never>((_, reject) => {
					setTimeout(() => {
						reject(
							new Error(
								`createDoomModule timed out after ${Date.now() - initStart}ms; wasmDebug=${wasmDebug.join(",")}`,
							),
						);
					}, 15000);
				}),
			]);
			this.module = moduleOrTimeout;
			this.debug("init:module-ready");
			if (!this.module) {
				throw new Error("Failed to initialize DOOM module");
			}
			await this.yieldAfterProgress("DOOM init: module instantiated.");
		} finally {
			this.debug("init:restore-webassembly-globals");
			(WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = originalCompile;
			(WebAssembly as unknown as { instantiate: typeof WebAssembly.instantiate }).instantiate =
				originalInstantiate;
		}

		// Initialize DOOM
		await this.yieldAfterProgress("DOOM init: booting engine...");
		this.debug("init:before-initDoom");
		this.initDoom();
		await this.yieldAfterProgress("DOOM init: engine booted.");
		this.debug("init:after-initDoom");

		// Get framebuffer info
		this.frameBufferPtr = this.module._DG_GetFrameBuffer();
		this._width = this.module._DG_GetScreenWidth();
		this._height = this.module._DG_GetScreenHeight();
		this.initialized = true;
		await this.yieldAfterProgress(`DOOM init: framebuffer ready (${this._width}x${this._height}).`);
		this.debug(`init:framebuffer=${this._width}x${this._height}`);
	}

	private initDoom(): void {
		if (!this.module) return;
		this.debug("initDoom:start");

		const args = ["doom", "-iwad", "/doom/doom1.wad"];
		const argPtrs: number[] = [];

		for (const arg of args) {
			const ptr = this.module._malloc(arg.length + 1);
			for (let i = 0; i < arg.length; i++) {
				this.module.setValue(ptr + i, arg.charCodeAt(i), "i8");
			}
			this.module.setValue(ptr + arg.length, 0, "i8");
			argPtrs.push(ptr);
		}

		const argvPtr = this.module._malloc(argPtrs.length * 4);
		for (let i = 0; i < argPtrs.length; i++) {
			this.module.setValue(argvPtr + i * 4, argPtrs[i]!, "i32");
		}

		this.module._doomgeneric_Create(args.length, argvPtr);
		this.debug("initDoom:after-create");

		for (const ptr of argPtrs) {
			this.module._free(ptr);
		}
		this.module._free(argvPtr);
		this.debug("initDoom:done");
	}

	/**
	 * Run one game tick
	 */
	tick(): void {
		if (!this.module || !this.initialized) return;
		this.module._doomgeneric_Tick();
	}

	/**
	 * Get current frame as RGBA pixel data
	 * DOOM outputs ARGB, we convert to RGBA
	 */
	getFrameRGBA(): Uint8Array {
		if (!this.module || !this.initialized) {
			return new Uint8Array(this._width * this._height * 4);
		}

		const pixels = this._width * this._height;
		const buffer = new Uint8Array(pixels * 4);

		for (let i = 0; i < pixels; i++) {
			const argb = this.module.getValue(this.frameBufferPtr + i * 4, "i32");
			const offset = i * 4;
			buffer[offset + 0] = (argb >> 16) & 0xff; // R
			buffer[offset + 1] = (argb >> 8) & 0xff; // G
			buffer[offset + 2] = argb & 0xff; // B
			buffer[offset + 3] = 255; // A
		}

		return buffer;
	}

	/**
	 * Push a key event
	 */
	pushKey(pressed: boolean, key: number): void {
		if (!this.module || !this.initialized) return;
		this.module._DG_PushKeyEvent(pressed ? 1 : 0, key);
	}

	isInitialized(): boolean {
		return this.initialized;
	}
}
