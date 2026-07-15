import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

type SitesPluginOptions = {
  hostingConfig: string;
  drizzleSource: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(options: SitesPluginOptions): Plugin {
  let root = process.cwd();
  let buildOutput = resolve(root, "dist");

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
      buildOutput = resolve(root, config.build.outDir);
    },
    async closeBundle() {
      const outputDirectory = resolve(buildOutput, ".openai");
      const hostingConfig = resolve(root, options.hostingConfig);
      const drizzleSource = resolve(root, options.drizzleSource);

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
    },
  };
}
