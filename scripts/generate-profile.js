#!/usr/bin/env node

// Generates a dependency-free profile card. The lines-of-code number is an
// approximation: squash merges, changed identities, rewritten history, shallow
// clones, and private repositories all affect what Git can attribute.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const username = process.env.GITHUB_USERNAME?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const preview = process.argv.includes("--preview");

if (!username) throw new Error("GITHUB_USERNAME is required");
if (!token && !preview) throw new Error("GITHUB_TOKEN is required (or use --preview to validate rendering)");

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

function svg(theme, data, loc) {
  const dark = theme === "dark";
  const c = dark
    ? { bg: "#0d1117", card: "#161b22", border: "#30363d", text: "#e6edf3", muted: "#8b949e", accent: "#58a6ff", green: "#3fb950", yellow: "#d29922" }
    : { bg: "#f6f8fa", card: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#656d76", accent: "#0969da", green: "#1a7f37", yellow: "#9a6700" };
  const s = (x, y, label, value) => `<text x="${x}" y="${y}" class="label">${xml(label)}</text><text x="${x + (x < 700 ? 190 : 142)}" y="${y}" class="value">${xml(value)}</text>`;
  const contributions = data.contributions;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720" role="img" aria-label="Saad Hassan GitHub profile and statistics">
  <style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.label{fill:${c.muted};font-size:15px}.value{fill:${c.text};font-size:15px}.heading{fill:${c.accent};font-size:16px;font-weight:700}.ascii{fill:${c.green};font-size:18px;font-weight:700}.rule{stroke:${c.border};stroke-width:1}</style>
  <rect width="1200" height="720" fill="${c.bg}"/><rect x="25" y="25" width="1150" height="670" rx="16" fill="${c.card}" stroke="${c.border}" stroke-width="2"/>
  <circle cx="55" cy="57" r="7" fill="#ff5f56"/><circle cx="78" cy="57" r="7" fill="#ffbd2e"/><circle cx="101" cy="57" r="7" fill="#27c93f"/>
  <text x="600" y="63" text-anchor="middle" fill="${c.muted}" font-size="14">${xml(username.toLowerCase())}@github — profile</text>
  <line x1="25" y1="84" x2="1175" y2="84" class="rule"/>
  <text x="58" y="120" fill="${c.muted}" font-size="13">SaadHassan / README.md</text>
  <g class="ascii"><text x="65" y="190">┌──────────────────┐</text><text x="65" y="220">│  &lt; SAAD /&gt;       │</text><text x="65" y="250">│                  │</text><text x="65" y="280">│  { build: ship } │</text><text x="65" y="310">│  [■■■■■■■■■■]  ✓ │</text><text x="65" y="340">└──────────────────┘</text></g>
  <text x="65" y="395" fill="${c.accent}" font-size="20" font-weight="700">Saad Hassan</text><text x="65" y="423" fill="${c.muted}" font-size="14">${xml(username)}</text>
  <text x="385" y="155" class="heading">PROFILE</text><line x1="385" y1="169" x2="1128" y2="169" class="rule"/>
  ${s(385,200,"Role","Full-Stack / Backend Software Engineer")}${s(385,230,"Focus","TypeScript, Node.js, React, PostgreSQL")}${s(385,260,"Specialty","MERN Stack and AI Integration")}${s(385,290,"Company","Layer7 Solutions")}${s(385,320,"Education","BS Computer Science — GIKI")}${s(385,350,"Location","Lahore, Pakistan")}
  <text x="385" y="395" class="heading">CURRENT WORK</text><line x1="385" y1="409" x2="1128" y2="409" class="rule"/>
  ${s(385,440,"Project","NexCubator")}${s(385,470,"Learning","AWS Solutions Architect")}${s(385,500,"Available for","Backend and Full-Stack opportunities")}
  <text x="65" y="520" class="heading">OPEN SOURCE</text><line x1="65" y1="534" x2="340" y2="534" class="rule"/>
  <text x="65" y="563" class="value">Prisma ORM · PostgreSQL</text><text x="65" y="590" class="value">Chromium</text><text x="65" y="625" class="label">Databases · distributed systems</text><text x="65" y="650" class="label">cloud · open source</text>
  <text x="385" y="545" class="heading">GITHUB STATISTICS</text><line x1="385" y1="559" x2="1128" y2="559" class="rule"/>
  ${s(385,590,"Repositories",fmt(data.publicRepos))}${s(385,620,"Stars received",fmt(data.stars))}${s(385,650,"Default-branch commits",fmt(data.totalCommits))}${s(780,590,`${data.year} commits`,fmt(contributions.totalCommitContributions))}${s(780,620,"PRs / issues",`${fmt(contributions.totalPullRequestContributions)} / ${fmt(contributions.totalIssueContributions)}`)}${s(780,650,"PR reviews",fmt(contributions.totalPullRequestReviewContributions))}
  <text x="385" y="678" class="label">Account age: ${xml(`${data.accountYears} years`)}</text><text x="780" y="678" fill="${c.yellow}" font-size="14">Lines of Code: ${fmt(loc.added)}++ / ${fmt(loc.removed)}-- ≈</text>
</svg>\n`;
}

async function main() {
  console.log(preview ? "Generating preview assets…" : `Fetching GitHub data for ${username}…`);
  const data = preview ? { repos: [], publicRepos: 0, stars: 0, totalCommits: 0, accountYears: 0, year: new Date().getUTCFullYear(), contributions: { totalCommitContributions: 0, totalPullRequestContributions: 0, totalIssueContributions: 0, totalPullRequestReviewContributions: 0 } } : await getGitHubData();
  const loc = preview ? { added: 0, removed: 0, analysed: 0 } : await calculateLoc(data.repos);
  await mkdir("assets", { recursive: true });
  await Promise.all([writeFile("assets/profile-light.svg", svg("light", data, loc)), writeFile("assets/profile-dark.svg", svg("dark", data, loc))]);
  console.log(`Wrote both themes; ${data.publicRepos} repositories, ${loc.analysed} analysed for LOC.`);
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
