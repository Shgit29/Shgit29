#!/usr/bin/env node

// Generates a dependency-free profile card. The lines-of-code number is an
// approximation: squash merges, changed identities, rewritten history, shallow
// clones, and private repositories all affect what Git can attribute.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const username = process.env.GITHUB_USERNAME?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const preview = process.argv.includes("--preview");

const split = (value) => (value || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const authorNames = split(process.env.GIT_AUTHOR_NAMES || "Saad Hassan");
const authorEmails = split(process.env.GIT_AUTHOR_EMAILS);
const maxLocRepos = positiveInt("LOC_MAX_REPOS", 50);
const cloneDepth = positiveInt("LOC_CLONE_DEPTH", 500);

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

async function readAsciiArt() {
  let asciiText;
  try {
    asciiText = await readFile("assets/profile-ascii.txt", "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("assets/profile-ascii.txt is missing.");
    throw new Error(`Unable to read assets/profile-ascii.txt: ${error.message}`);
  }

  const lines = asciiText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/u, ""));

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) throw new Error("assets/profile-ascii.txt is empty.");
  return lines;
}

const fmt = (n) => new Intl.NumberFormat("en-US").format(n || 0);

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-readme-generator" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data;
}

async function getGitHubData() {
  const year = new Date().getUTCFullYear();
  const profile = await graphql(`query($login:String!,$from:DateTime!,$to:DateTime!){
    user(login:$login){id createdAt contributionsCollection(from:$from,to:$to){totalCommitContributions totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions}}
  }`, { login: username, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` });
  if (!profile.user) throw new Error(`GitHub user ${username} was not found`);
  let cursor = null;
  const repos = [];
  do {
    const data = await graphql(`query($login:String!,$cursor:String){
      user(login:$login){
        repositories(first:100,after:$cursor,ownerAffiliations:OWNER,privacy:PUBLIC,orderBy:{field:NAME,direction:ASC}){
          pageInfo{hasNextPage endCursor}
          nodes{name isFork stargazerCount url}
        }
      }
    }`, {
      login: username, cursor,
    });
    if (!data.user) throw new Error(`GitHub user ${username} was not found`);
    repos.push(...data.user.repositories.nodes.filter((r) => !r.isFork));
    cursor = data.user.repositories.pageInfo.hasNextPage ? data.user.repositories.pageInfo.endCursor : null;
  } while (cursor);

  // Fetch accurate authored-commit counts in batches after resolving the user id.
  let totalCommits = 0;
  for (let i = 0; i < repos.length; i += 40) {
    const batch = repos.slice(i, i + 40);
    const fields = batch.map((r, j) => `r${j}:repository(owner:${JSON.stringify(username)},name:${JSON.stringify(r.name)}){defaultBranchRef{target{... on Commit{history(first:1,author:{id:${JSON.stringify(profile.user.id)}}){totalCount}}}}}`).join("\n");
    const data = await graphql(`query{${fields}}`, {});
    totalCommits += Object.values(data).reduce((sum, r) => sum + (r?.defaultBranchRef?.target?.history?.totalCount || 0), 0);
  }
  return {
    repos, publicRepos: repos.length,
    stars: repos.reduce((sum, r) => sum + r.stargazerCount, 0), totalCommits,
    contributions: profile.user.contributionsCollection,
    accountYears: Math.max(0, Math.floor((Date.now() - new Date(profile.user.createdAt).getTime()) / 31_556_952_000)), year,
  };
}

function identityMatches(name, email) {
  return (!authorNames.length && !authorEmails.length) || authorNames.includes(name.toLowerCase()) || authorEmails.includes(email.toLowerCase());
}

async function calculateLoc(repos) {
  if (!authorNames.length && !authorEmails.length) console.warn("No author identities configured; LOC will include every author.");
  const root = await mkdtemp(join(tmpdir(), "profile-loc-"));
  let added = 0, removed = 0, analysed = 0;
  try {
    for (const [index, repo] of repos.slice(0, maxLocRepos).entries()) {
      const dir = join(root, String(index));
      try {
        console.log(`Analysing ${repo.name}…`);
        await exec("git", ["clone", "--quiet", "--depth", String(cloneDepth), "--filter=blob:none", "--no-tags", repo.url + ".git", dir], { timeout: 120_000 });
        const { stdout } = await exec("git", ["-C", dir, "log", "--format=@@@%an%x00%ae", "--numstat", "--no-renames"], { maxBuffer: 100 * 1024 * 1024, timeout: 120_000 });
        let include = false;
        for (const line of stdout.split("\n")) {
          if (line.startsWith("@@@")) {
            const [name = "", email = ""] = line.slice(3).split("\0");
            include = identityMatches(name, email);
          } else if (include) {
            const match = line.match(/^(\d+)\t(\d+)\t/);
            if (match) { added += Number(match[1]); removed += Number(match[2]); }
          }
        }
        analysed++;
      } catch (error) {
        console.warn(`Skipping ${repo.name}: ${error.message}`);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  return { added, removed, analysed };
}

function renderAsciiArt(lines) {
  const panel = { x: 25, y: 22, width: 385, height: 540 };
  const widestLine = Math.max(...lines.map((line) => Array.from(line).length), 1);
  // Monospace glyphs are approximately 0.62em wide. The slightly larger 0.66
  // factor leaves a safety margin for GitHub's supported fallback fonts.
  const widthLimitedSize = panel.width / (widestLine * 0.66);
  const heightLimitedSize = panel.height / (lines.length * 1.2);
  const fontSize = Math.floor(Math.min(14, widthLimitedSize, heightLimitedSize) * 100) / 100;
  const lineHeight = Math.floor(fontSize * 1.2 * 100) / 100;
  const tspans = lines.map((line, index) =>
    `<tspan x="${panel.x}" dy="${index === 0 ? 0 : lineHeight}">${xml(line)}</tspan>`,
  ).join("");

  return `<text x="${panel.x}" y="${panel.y + fontSize}" class="ascii" xml:space="preserve" font-size="${fontSize}">${tspans}</text>`;
}

function svg(theme, data, loc, asciiLines) {
  const dark = theme === "dark";
  const c = dark
    ? { page: "#0d1117", panel: "#151b23", border: "#222b36", text: "#c9d1d9", muted: "#748496", value: "#a8d8ff", accent: "#ff9d3d", green: "#39d353", red: "#ff5c57" }
    : { page: "#f3f4f6", panel: "#ffffff", border: "#d8dee4", text: "#30363d", muted: "#8c959f", value: "#0969da", accent: "#bc4c00", green: "#1a7f37", red: "#cf222e" };
  const contributions = data.contributions;
  const row = (y, label, value, valueClass = "value") => {
    const dots = "·".repeat(Math.max(2, 62 - label.length - String(value).length));
    return `<text x="448" y="${y}" class="row"><tspan class="key">${xml(label)}:</tspan><tspan class="dots"> ${dots} </tspan><tspan class="${valueClass}">${xml(value)}</tspan></text>`;
  };
  const section = (y, title) => `<text x="430" y="${y}" class="section">- ${xml(title)}  ${"─".repeat(Math.max(3, 61 - title.length))}</text>`;
  const artSvg = renderAsciiArt(asciiLines);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="584" viewBox="0 0 1080 584" role="img" aria-label="Saad Hassan profile and GitHub statistics in a terminal system-information layout">
  <style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.ascii{fill:${c.text};white-space:pre}.row{font-size:16px}.key{fill:${c.accent}}.dots{fill:${c.muted}}.value{fill:${c.value}}.green{fill:${c.green}}.red{fill:${c.red}}.section{fill:${c.text};font-size:16px}</style>
  <rect width="1080" height="584" fill="${c.page}"/><rect x="8" y="7" width="1058" height="570" rx="17" fill="${c.panel}" stroke="${c.border}"/>
  ${artSvg}
  <text x="430" y="39" class="section">${xml(username.toLowerCase())}@github  ${"─".repeat(48)}</text>
  ${row(67,"Role","Full-Stack / Backend Software Engineer")}
  ${row(91,"Focus","TypeScript, Node.js, React, PostgreSQL")}
  ${row(115,"Specialty","MERN Stack and AI Integration")}
  ${row(139,"Company","Layer7 Solutions")}
  ${row(163,"Education","BS Computer Science — GIKI")}
  ${row(187,"Location","Lahore, Pakistan")}
  ${section(226,"Current Work")}
  ${row(254,"Project","NexCubator")}
  ${row(278,"Learning","AWS Solutions Architect")}
  ${row(302,"Availability","Backend and Full-Stack opportunities")}
  ${row(326,"Open Source","Prisma ORM, PostgreSQL, Chromium")}
  ${row(350,"Interests","Databases, distributed systems, cloud")}
  ${section(389,"GitHub Stats")}
  ${row(417,"Public Repos",fmt(data.publicRepos))}
  ${row(441,"Stars Received",fmt(data.stars))}
  ${row(465,"Default-Branch Commits",fmt(data.totalCommits))}
  ${row(489,`${data.year} Contributions`,`${fmt(contributions.totalCommitContributions)} commits · ${fmt(contributions.totalPullRequestContributions)} PRs · ${fmt(contributions.totalIssueContributions)} issues`)}
  ${row(513,"PR Reviews",fmt(contributions.totalPullRequestReviewContributions))}
  ${row(537,"Account Age",`${fmt(data.accountYears)} years`)}
  <text x="448" y="561" class="row"><tspan class="key">Lines of Code:</tspan><tspan class="dots"> ················· </tspan><tspan class="value">${fmt(loc.added)}</tspan><tspan class="green">++</tspan><tspan class="value"> / ${fmt(loc.removed)}</tspan><tspan class="red">--</tspan><tspan class="dots"> ≈</tspan></text>
</svg>\n`;
}

async function main() {
  const asciiLines = await readAsciiArt();
  if (!username) throw new Error("GITHUB_USERNAME is required");
  if (!token && !preview) throw new Error("GITHUB_TOKEN is required (or use --preview to validate rendering)");
  console.log(`Loaded ${asciiLines.length} ASCII-art lines from assets/profile-ascii.txt.`);
  console.log(preview ? "Generating preview assets…" : `Fetching GitHub data for ${username}…`);
  const data = preview ? { repos: [], publicRepos: 0, stars: 0, totalCommits: 0, accountYears: 0, year: new Date().getUTCFullYear(), contributions: { totalCommitContributions: 0, totalPullRequestContributions: 0, totalIssueContributions: 0, totalPullRequestReviewContributions: 0 } } : await getGitHubData();
  const loc = preview ? { added: 0, removed: 0, analysed: 0 } : await calculateLoc(data.repos);
  await mkdir("assets", { recursive: true });
  await Promise.all([writeFile("assets/profile-light.svg", svg("light", data, loc, asciiLines)), writeFile("assets/profile-dark.svg", svg("dark", data, loc, asciiLines))]);
  console.log(`Wrote both themes; ${data.publicRepos} repositories, ${loc.analysed} analysed for LOC.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
