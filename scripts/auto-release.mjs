#!/usr/bin/env node
/**
 * Fully automatic releases: on every push to main, compute the next semver
 * from conventional commits since the last v* tag (first-parent walk, one
 * entry per merged PR), bump package.json + jsr.json, prepend a CHANGELOG
 * section, commit to main, cut the annotated tag, push both. release.yml
 * (on: push: tags) re-runs all gates and publishes npm + JSR.
 *
 * Pushes authenticate via the credential actions/checkout persisted from its
 * `token:` input (RELEASE_PAT) — and that credential must be a HUMAN actor:
 * JSR trusted publishing rejects bot tokens (actorNotScopeMember). Commits
 * and tags carry inline identity because CI runners have no gitconfig.
 *
 * Semver rules (conventional): feat → minor, fix/perf → patch, `!` or
 * `BREAKING CHANGE:` in body → major; other types (chore/docs/test/ci/…)
 * release nothing.
 *
 * --dry-run computes and prints the release without touching files, git or
 * remotes. Rerun-safe: a partial push (main bumped, tag push failed) heals
 * on the next trigger — files ahead of the last tag just cuts the missing
 * tag.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REPO_URL = "https://github.com/woss/seal-ts";

/** Classify one conventional-commit subject → 'major'|'minor'|'patch'|null. */
export function classifySubject(subject) {
  const m =
    /^(feat|fix|perf|refactor|docs|test|build|ci|chore|style)(\([^)]*\))?(!)?:\s/.exec(
      subject,
    );
  if (!m) {
    return null;
  } // "Merge pull request …", "omp stuff" — no release impact
  if (m[3] === "!") {
    return "major";
  }
  if (m[1] === "feat") {
    return "minor";
  }
  if (m[1] === "fix" || m[1] === "perf") {
    return "patch";
  }
  return null;
}

export function nextVersion(current, bump) {
  const [maj, min, pat] = current.split(".").map(Number);
  if (bump === "major") {
    return `${maj + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${maj}.${min + 1}.0`;
  }
  return `${maj}.${min}.${pat + 1}`;
}

/** CHANGELOG section in the exact format release.yml's awk extractor slices. */
export function changelogSection({
  version,
  prevTag,
  date,
  features,
  fixes,
  perfs,
}) {
  const lines = [
    `## [${version}](${REPO_URL}/compare/${prevTag}...v${version}) (${date})`,
    "",
  ];
  const group = (title, items) => {
    if (!items.length) {
      return;
    }
    lines.push(`### ${title}`, "");
    for (const it of items) {
      lines.push(
        `* ${it.subject} ([${it.sha.slice(0, 7)}](${REPO_URL}/commit/${it.sha}))`,
      );
    }
    lines.push("");
  };
  group("Features", features);
  group("Bug Fixes", fixes);
  group("Performance Improvements", perfs);
  return lines.join("\n").trimEnd() + "\n";
}

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  }).trim();
}

/** First-parent commits since lastTag → { type, sha, subject, breaking }. */
function collect(lastTag, cwd) {
  const raw = sh(
    `git log --first-parent ${lastTag}..HEAD --format='%H%x00%s%x00%b%x01'`,
    { cwd },
  );
  return raw
    .split("\x01")
    .filter((e) => e.trim())
    .map((entry) => {
      const [sha, subject, body] = entry.split("\x00");
      // Merge commit: PR title rides in the body, classify that.
      const isMerge = subject.startsWith("Merge pull request ");
      const title = isMerge
        ? (body
            .split("\n")
            .map((l) => l.trim())
            .find(Boolean) ?? "")
        : subject;
      return { sha, subject: title, breaking: /BREAKING CHANGE:/.test(body) };
    });
}

export async function main({ cwd = process.cwd(), dryRun = false } = {}) {
  const lastTags = sh(`git tag --sort=-creatordate --merged HEAD --list 'v*'`, {
    cwd,
  });
  if (!lastTags) {
    console.log(
      "auto-release: no v* tag found — bootstrap by tagging the first release manually",
    );
    return null;
  }
  const prevTag = lastTags.split("\n")[0];
  const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, "utf8"));

  // Recovery: a previous run pushed the bump to main but died before the tag
  // (files' version ahead of the last v* tag). Cut the missing tag at HEAD
  // and push it — the human-actor credential from the checkout is what JSR
  // trusted publishing requires.
  if (`v${pkg.version}` !== prevTag) {
    let tagged;
    try {
      tagged = !!sh(`git ls-remote --tags origin refs/tags/v${pkg.version}`, {
        cwd,
      });
    } catch {
      tagged = !!sh(`git tag --list v${pkg.version}`, { cwd });
    }
    if (tagged) {
      console.log(`auto-release: v${pkg.version} already tagged — skipping`);
      return null;
    }
    console.log(
      `auto-release: v${pkg.version} merged but untagged — tagging HEAD`,
    );
    if (dryRun) {
      return pkg.version;
    }
    sh(
      `git -c user.name='seal-ts-release' -c user.email='daniel@woss.io' tag -a v${pkg.version} -m 'chore(release): v${pkg.version}'`,
      { cwd },
    );
    sh(`git push origin v${pkg.version}`, { cwd });
    console.log(
      `auto-release: pushed v${pkg.version} — release.yml is publishing`,
    );
    return pkg.version;
  }

  // Release-PR mode below: main is version-consistent with prevTag.
  const commits = collect(prevTag, cwd);
  if (!commits.length) {
    console.log(
      `auto-release: no commits since ${prevTag} — nothing to release`,
    );
    return null;
  }

  const RANK = { patch: 1, minor: 2, major: 3 };
  let bump = null;
  for (const c of commits) {
    const b = c.breaking ? "major" : classifySubject(c.subject);
    if (b && (!bump || RANK[b] > RANK[bump])) {
      bump = b;
    }
  }
  if (!bump) {
    console.log(
      `auto-release: only non-release commits since ${prevTag} — skipping`,
    );
    return null;
  }

  const version = nextVersion(pkg.version, bump);
  // Remote check (survives reruns after a partial push); falls back to local
  // tags in test repos with no origin.
  let tagged;
  try {
    tagged = !!sh(`git ls-remote --tags origin refs/tags/v${version}`, { cwd });
  } catch {
    tagged = !!sh(`git tag --list v${version}`, { cwd });
  }
  if (tagged) {
    console.log(`auto-release: v${version} already exists — skipping`);
    return null;
  }

  const { features, fixes, perfs } = { features: [], fixes: [], perfs: [] };
  for (const c of commits) {
    if (classifySubject(c.subject) === "minor") {
      features.push(c);
    } else if (classifySubject(c.subject) === "patch") {
      (c.subject.startsWith("perf") ? perfs : fixes).push(c);
    }
  }
  const section = changelogSection({
    version,
    prevTag,
    date: new Date().toISOString().slice(0, 10),
    features,
    fixes,
    perfs,
  });

  console.log(`auto-release: ${bump} bump → v${version}`);
  for (const c of [...features, ...fixes, ...perfs]) {
    console.log(`  ${c.subject} (${c.sha.slice(0, 7)})`);
  }
  if (dryRun) {
    console.log(
      `auto-release: --dry-run, would prepend to CHANGELOG.md:\n${section}`,
    );
    return version;
  }

  for (const f of ["package.json", "jsr.json"]) {
    const j = JSON.parse(readFileSync(`${cwd}/${f}`, "utf8"));
    writeFileSync(
      `${cwd}/${f}`,
      JSON.stringify({ ...j, version }, null, 2) + "\n",
    );
  }
  const changelog = readFileSync(`${cwd}/CHANGELOG.md`, "utf8");
  writeFileSync(`${cwd}/CHANGELOG.md`, section + changelog);

  if (sh("git status --porcelain", { cwd })) {
    sh("git add package.json jsr.json CHANGELOG.md", { cwd });
    // -c identity: CI runners have none configured (actions/checkout sets
    // neither user.name nor user.email); author metadata is informational —
    // JSR trusted publishing keys off the tag-pushing credential, not this.
    sh(
      `git -c user.name='seal-ts-release' -c user.email='daniel@woss.io' commit -m 'chore(release): v${version}'`,
      { cwd },
    );
  }

  sh(`git push origin HEAD:main`, { cwd });
  sh(
    `git -c user.name='seal-ts-release' -c user.email='daniel@woss.io' tag -a v${version} -m 'chore(release): v${version}'`,
    { cwd },
  );
  sh(`git push origin v${version}`, { cwd });
  console.log(
    `auto-release: pushed main + v${version} — release.yml is publishing`,
  );
  return version;
}

if (process.argv[1]?.endsWith("auto-release.mjs")) {
  await main({ dryRun: process.argv.includes("--dry-run") });
}
