/**
 * CLI command: ov update [--agents] [--manifest] [--hooks] [--sbx-kits] [--dry-run] [--json]
 *
 * Refreshes .overstory/ managed files from the installed npm package without
 * requiring a full `ov init`. Distinct from `ov upgrade` (which updates the
 * npm package itself).
 *
 * Managed files refreshed:
 * - Agent definitions (.overstory/agent-defs/*.md)
 * - agent-manifest.json
 * - hooks.json
 * - .gitignore
 * - README.md
 * - sbx-kits/ (when --sbx-kits or no granular flags)
 *
 * Does NOT touch: config.yaml, config.local.yaml, SQLite databases,
 * agents/, worktrees/, specs/, logs/, or .claude/settings.local.json.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess } from "../logging/color.ts";
import {
	buildAgentManifest,
	buildHooksJson,
	OVERSTORY_GITIGNORE,
	OVERSTORY_README,
	writeOverstoryGitignore,
	writeOverstoryReadme,
} from "./init.ts";

export interface UpdateOptions {
	agents?: boolean;
	manifest?: boolean;
	hooks?: boolean;
	sbxKits?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

/** Agent def files to exclude (deprecated). */
const EXCLUDED_AGENT_DEFS = new Set(["supervisor.md"]);

interface UpdateResult {
	agentDefs: { updated: string[]; unchanged: string[] };
	manifest: { updated: boolean };
	hooks: { updated: boolean };
	sbxKits: { updated: string[]; unchanged: string[] };
	gitignore: { updated: boolean };
	readme: { updated: boolean };
}

/**
 * Entry point for `ov update [flags]`.
 */
export async function executeUpdate(opts: UpdateOptions): Promise<void> {
	const json = opts.json ?? false;
	const dryRun = opts.dryRun ?? false;

	const projectRoot = process.cwd();
	const overstoryDir = join(projectRoot, ".overstory");

	// Verify .overstory/config.yaml exists (already initialized)
	const configFile = Bun.file(join(overstoryDir, "config.yaml"));
	if (!(await configFile.exists())) {
		throw new ValidationError("Not initialized. Run 'ov init' first to set up .overstory/.", {
			field: "config.yaml",
		});
	}

	// Determine what to refresh. No flags = refresh all.
	const hasGranularFlags = opts.agents || opts.manifest || opts.hooks || opts.sbxKits;
	const doAgents = hasGranularFlags ? (opts.agents ?? false) : true;
	const doManifest = hasGranularFlags ? (opts.manifest ?? false) : true;
	const doHooks = hasGranularFlags ? (opts.hooks ?? false) : true;
	const doSbxKits = hasGranularFlags ? (opts.sbxKits ?? false) : true;
	const doGitignore = !hasGranularFlags;
	const doReadme = !hasGranularFlags;

	const result: UpdateResult = {
		agentDefs: { updated: [], unchanged: [] },
		manifest: { updated: false },
		hooks: { updated: false },
		sbxKits: { updated: [], unchanged: [] },
		gitignore: { updated: false },
		readme: { updated: false },
	};

	// 1. Refresh agent definitions
	if (doAgents) {
		const sourceDir = join(import.meta.dir, "..", "..", "agents");
		const targetDir = join(overstoryDir, "agent-defs");

		await mkdir(targetDir, { recursive: true });

		const sourceFiles = await readdir(sourceDir);
		for (const fileName of sourceFiles) {
			if (!fileName.endsWith(".md")) continue;
			if (EXCLUDED_AGENT_DEFS.has(fileName)) continue;

			const sourceContent = await Bun.file(join(sourceDir, fileName)).text();
			const targetPath = join(targetDir, fileName);
			const targetFile = Bun.file(targetPath);

			let needsUpdate = true;
			if (await targetFile.exists()) {
				const existing = await targetFile.text();
				if (existing === sourceContent) {
					needsUpdate = false;
				}
			}

			if (needsUpdate) {
				if (!dryRun) {
					await Bun.write(targetPath, sourceContent);
				}
				result.agentDefs.updated.push(fileName);
			} else {
				result.agentDefs.unchanged.push(fileName);
			}
		}
	}

	// 2. Refresh agent-manifest.json
	if (doManifest) {
		const manifestPath = join(overstoryDir, "agent-manifest.json");
		const newContent = `${JSON.stringify(buildAgentManifest(), null, "\t")}\n`;
		const manifestFile = Bun.file(manifestPath);

		let needsUpdate = true;
		if (await manifestFile.exists()) {
			const existing = await manifestFile.text();
			if (existing === newContent) {
				needsUpdate = false;
			}
		}

		if (needsUpdate) {
			if (!dryRun) {
				await Bun.write(manifestPath, newContent);
			}
			result.manifest.updated = true;
		}
	}

	// 3. Refresh hooks.json
	if (doHooks) {
		const hooksPath = join(overstoryDir, "hooks.json");
		const newContent = buildHooksJson();
		const hooksFile = Bun.file(hooksPath);

		let needsUpdate = true;
		if (await hooksFile.exists()) {
			const existing = await hooksFile.text();
			if (existing === newContent) {
				needsUpdate = false;
			}
		}

		if (needsUpdate) {
			if (!dryRun) {
				await Bun.write(hooksPath, newContent);
			}
			result.hooks.updated = true;
		}
	}

	// 4. Refresh sbx-kits
	if (doSbxKits) {
		const sourceKitsDir = join(import.meta.dir, "..", "..", "templates", "sbx-kits");
		const targetKitsDir = join(overstoryDir, "sbx-kits");

		await mkdir(targetKitsDir, { recursive: true });

		const kitNames = await readdir(sourceKitsDir);
		for (const kitName of kitNames) {
			const sourceKitDir = join(sourceKitsDir, kitName);
			const targetKitDir = join(targetKitsDir, kitName);
			await mkdir(targetKitDir, { recursive: true });

			const kitFiles = await readdir(sourceKitDir);
			for (const fileName of kitFiles) {
				const sourceContent = await Bun.file(join(sourceKitDir, fileName)).text();
				const targetPath = join(targetKitDir, fileName);
				const targetFile = Bun.file(targetPath);

				let needsUpdate = true;
				if (await targetFile.exists()) {
					const existing = await targetFile.text();
					if (existing === sourceContent) {
						needsUpdate = false;
					}
				}

				const relPath = `sbx-kits/${kitName}/${fileName}`;
				if (needsUpdate) {
					if (!dryRun) {
						await Bun.write(targetPath, sourceContent);
					}
					result.sbxKits.updated.push(relPath);
				} else {
					result.sbxKits.unchanged.push(relPath);
				}
			}
		}
	}

	// 5. Refresh .gitignore
	if (doGitignore) {
		const gitignorePath = join(overstoryDir, ".gitignore");
		const gitignoreFile = Bun.file(gitignorePath);

		let needsUpdate = true;
		if (await gitignoreFile.exists()) {
			const existing = await gitignoreFile.text();
			if (existing === OVERSTORY_GITIGNORE) {
				needsUpdate = false;
			}
		}

		if (needsUpdate) {
			if (!dryRun) {
				await writeOverstoryGitignore(overstoryDir);
			}
			result.gitignore.updated = true;
		}
	}

	// 5. Refresh README.md
	if (doReadme) {
		const readmePath = join(overstoryDir, "README.md");
		const readmeFile = Bun.file(readmePath);

		let needsUpdate = true;
		if (await readmeFile.exists()) {
			const existing = await readmeFile.text();
			if (existing === OVERSTORY_README) {
				needsUpdate = false;
			}
		}

		if (needsUpdate) {
			if (!dryRun) {
				await writeOverstoryReadme(overstoryDir);
			}
			result.readme.updated = true;
		}
	}

	// Output
	if (json) {
		jsonOutput("update", { dryRun, ...result });
		return;
	}

	const prefix = dryRun ? "Would update" : "Updated";
	let anyChanged = false;

	if (result.agentDefs.updated.length > 0) {
		anyChanged = true;
		for (const f of result.agentDefs.updated) {
			printSuccess(prefix, `agent-defs/${f}`);
		}
	}

	if (result.manifest.updated) {
		anyChanged = true;
		printSuccess(prefix, "agent-manifest.json");
	}

	if (result.hooks.updated) {
		anyChanged = true;
		printSuccess(prefix, "hooks.json");
		if (!dryRun) {
			printHint("If hooks are deployed, run 'ov hooks install --force' to redeploy");
		}
	}

	if (result.sbxKits.updated.length > 0) {
		anyChanged = true;
		for (const f of result.sbxKits.updated) {
			printSuccess(prefix, f);
		}
	}

	if (result.gitignore.updated) {
		anyChanged = true;
		printSuccess(prefix, ".gitignore");
	}

	if (result.readme.updated) {
		anyChanged = true;
		printSuccess(prefix, "README.md");
	}

	if (!anyChanged) {
		printSuccess("Already up to date");
	}
}

export function createUpdateCommand(): Command {
	return new Command("update")
		.description("Refresh .overstory/ managed files from the installed package")
		.option("--agents", "Refresh agent definition files only")
		.option("--manifest", "Refresh agent-manifest.json only")
		.option("--hooks", "Refresh hooks.json only")
		.option("--sbx-kits", "Refresh sbx kit files in .overstory/sbx-kits/ only")
		.option("--dry-run", "Show what would change without writing")
		.option("--json", "Output as JSON")
		.action(async (opts: UpdateOptions) => {
			await executeUpdate(opts);
		});
}
