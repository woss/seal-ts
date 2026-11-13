import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  changelogSection,
  classifySubject,
  main,
  nextVersion,
} from "./auto-release.mjs";

describe("classifySubject", () => {
  it("maps conventional types to semver bumps", () => {
    expect(classifySubject("feat: native verifier")).toBe("minor");
    expect(classifySubject("feat(scope): x")).toBe("minor");
    expect(classifySubject("fix: regenerate lockfile")).toBe("patch");
    expect(classifySubject("perf: cache transforms")).toBe("patch");
    expect(classifySubject("feat!: remove vendored validator")).toBe("major");
  });
  it("releases nothing for non-release types and noise", () => {
    for (const s of [
      "chore: release 0.3.0",
      "docs: update readme",
      "test: full coverage of verifier",
      "ci: bump node",
      "style: format",
      "refactor: shuffle modules",
      "omp stuff",
      "docs+fix: goldfish review round",
      "Merge pull request #9 from woss/feat/native-verifier",
    ]) {
      expect(classifySubject(s)).toBeNull();
    }
  });
});

describe("nextVersion", () => {
  it("bumps the right digit and zeroes the rest", () => {
    expect(nextVersion("0.2.0", "minor")).toBe("0.3.0");
    expect(nextVersion("0.3.0", "patch")).toBe("0.3.1");
    expect(nextVersion("0.3.0", "major")).toBe("1.0.0");
  });
});

describe("changelogSection", () => {
  it("emits the exact format release.yml extracts (## [X.Y.Z] … until next ##)", () => {
    const s = changelogSection({
      version: "0.4.0",
      prevTag: "v0.3.0",
      date: "2026-11-13",
      features: [{ sha: "abc1234def", subject: "new thing" }],
      fixes: [{ sha: "aaa0000bbb", subject: "fixed thing" }],
      perfs: [],
    });
    expect(s).toMatch(
      /^## \[0\.4\.0\]\(https:\/\/github\.com\/woss\/seal-ts\/compare\/v0\.3\.0\.\.\.v0\.4\.0\) \(2026-11-13\)\n\n### Features\n\n\* new thing \(\[abc1234\]/,
    );
    expect(s).toContain("### Bug Fixes");
    expect(s).toContain(
      "* fixed thing ([aaa0000](https://github.com/woss/seal-ts/commit/aaa0000bbb))",
    );
    expect(s).not.toContain("Performance");
  });
});

describe("main() integration (temp repo, dry-run)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function repo(commits: Array<[string, string?]>, identity = true): string {
    const dir = mkdtempSync(join(tmpdir(), "auto-release-test-"));
    dirs.push(dir);
    const g = (cmd: string) =>
      execSync(`git ${cmd}`, { cwd: dir, encoding: "utf8" });
    g("init -q");
    if (identity) {
      g("config user.name t");
      g("config user.email t@t");
    }
    writeFileSync(
      `${dir}/package.json`,
      JSON.stringify({ name: "@woss/seal-ts", version: "0.3.0" }, null, 2) +
        "\n",
    );
    writeFileSync(
      `${dir}/jsr.json`,
      JSON.stringify({ name: "@woss/seal-ts", version: "0.3.0" }, null, 2) +
        "\n",
    );
    writeFileSync(`${dir}/CHANGELOG.md`, "# Changelog\n");
    g("add -A");
    g(`commit -qm 'chore: bootstrap'`);
    g(`tag -a v0.3.0 -m 'v0.3.0'`);
    for (const [subject, body] of commits) {
      const esc = subject.replace(/'/g, "");
      if (body) {
        g(`commit -q --allow-empty -m '${esc}' -m '${body.replace(/'/g, "")}'`);
      } else {
        g(`commit -q --allow-empty -m '${esc}'`);
      }
    }
    return dir;
  }

  it("computes 0.4.0 from a merged feature PR and mutates nothing", async () => {
    const dir = repo([
      ["Merge pull request #9 from woss/feat/x", "feat: new thing"],
    ]);
    const version = await main({ cwd: dir, dryRun: true });
    expect(version).toBe("0.4.0");
    expect(
      execSync(`git status --porcelain`, { cwd: dir, encoding: "utf8" }),
    ).toBe("");
    expect(
      JSON.parse(execSync(`cat package.json`, { cwd: dir, encoding: "utf8" }))
        .version,
    ).toBe("0.3.0");
  });

  it("takes the max bump across commits; body BREAKING CHANGE wins", async () => {
    const dir = repo([
      ["fix: small bug"],
      ["Merge pull request #10 from woss/feat/y", "feat: bigger thing"],
      ["feat: another", "BREAKING CHANGE: drop the old API"],
    ]);
    expect(await main({ cwd: dir, dryRun: true })).toBe("1.0.0");
  });

  it("skips release for non-release commits only", async () => {
    const dir = repo([["chore: tidy"], ["docs: readme"]]);
    expect(await main({ cwd: dir, dryRun: true })).toBeNull();
  });

  it("exits cleanly when there are no commits since the tag", async () => {
    const dir = repo([]);
    expect(await main({ cwd: dir, dryRun: true })).toBeNull();
  });

  it("commits and tags with inline identity when the runner has none (CI regression)", async () => {
    // Identity-less work repo + bare origin = tonight's CI failure shape.
    const dir = repo([["Merge pull request #9 from woss/feat/x", "feat: new thing"]], false);
    const bare = mkdtempSync(join(tmpdir(), "auto-release-origin-"));
    dirs.push(bare);
    execSync(`git init -q --bare ${bare}`);
    execSync(`git remote add origin ${bare}`, { cwd: dir, encoding: "utf8" });
    // No GH_TOKEN involved: pushes authenticate via whatever credential the
    // checkout persisted (locally: none needed for a bare path remote).
    const version = await main({ cwd: dir, dryRun: false });
    expect(version).toBe("0.4.0");
    const log = execSync(`git log -1 --format='%an|%ae|%s'`, { cwd: dir, encoding: "utf8" });
    expect(log).toContain("seal-ts-release|daniel@woss.io|chore(release): v0.4.0");
    // Tag landed on the "origin" bare repo.
    expect(execSync(`git tag --list v0.4.0`, { cwd: bare, encoding: "utf8" }).trim()).toBe("v0.4.0");
  });
});
