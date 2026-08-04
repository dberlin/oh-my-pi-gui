/**
 * Generate the app icons from resources/icon-source.svg: a 1024px master PNG
 * (dev dock icon + Windows base), the macOS .icns (via an iconset + iconutil),
 * and the Linux resources/icons/*.png set. Run: `bun run scripts/gen-icons.ts`.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";

const resources = path.join(import.meta.dir, "..", "resources");
const svgPath = path.join(resources, "icon-source.svg");
const iconset = path.join(resources, "icon.iconset");

// (name, px) pairs for the macOS iconset; @2x entries are double resolution.
const ICONSET: [string, number][] = [
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
];
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function render(svg: Buffer, size: number): Promise<Buffer> {
	// High density so the vector mark stays crisp when resized down.
	return sharp(svg, { density: 384 }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

async function main(): Promise<void> {
	const svg = await fs.readFile(svgPath);

	// Master 1024px PNG (dev dock icon; also the base for Windows .ico).
	await Bun.write(path.join(resources, "icon.png"), await render(svg, 1024));

	// macOS iconset → icon.icns.
	await fs.rm(iconset, { recursive: true, force: true });
	await fs.mkdir(iconset, { recursive: true });
	for (const [name, px] of ICONSET) {
		await Bun.write(path.join(iconset, name), await render(svg, px));
	}
	execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "icon.icns")], { stdio: "inherit" });
	await fs.rm(iconset, { recursive: true, force: true });

	// Linux PNG set.
	const linuxDir = path.join(resources, "icons");
	await fs.mkdir(linuxDir, { recursive: true });
	for (const px of LINUX_SIZES) {
		await Bun.write(path.join(linuxDir, `${px}x${px}.png`), await render(svg, px));
	}

	console.log("Generated icon.png, icon.icns, and resources/icons/*.png");
}

await main();
