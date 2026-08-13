import * as fs from "node:fs/promises";
import * as path from "node:path";

interface NativeCompanionOptions {
	readonly nativeDir: string;
	readonly output: string;
	readonly filenames: readonly string[];
}

export async function copyNativeCompanions(options: NativeCompanionOptions): Promise<string[]> {
	const outputDirectory = path.dirname(options.output);
	await fs.mkdir(outputDirectory, { recursive: true });
	const copied: string[] = [];
	for (const filename of options.filenames) {
		const destination = path.join(outputDirectory, filename);
		try {
			await fs.copyFile(path.join(options.nativeDir, filename), destination);
			copied.push(destination);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	if (copied.length === 0) {
		throw new Error(`No native companion found in ${options.nativeDir}: ${options.filenames.join(", ")}`);
	}
	return copied;
}
