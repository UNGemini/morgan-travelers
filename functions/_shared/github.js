/**
 * Shared GitHub helpers for Pages Functions + Vite dev middleware.
 * Pure fetch — works on Cloudflare Workers and Node 18+.
 */

export const GH_API = "https://api.github.com";
export const COOKIE_NAME = "morgan_gh_sess";
export const DEFAULT_OVERRIDES_REPO = "UNGemini/morgan-travelers-overrides";

/** @param {string} s */
export function b64encode(s) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "utf8").toString("base64");
  }
  return btoa(unescape(encodeURIComponent(s)));
}

/** @param {string} s */
export function b64decode(s) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(s, "base64").toString("utf8");
  }
  return decodeURIComponent(escape(atob(s)));
}

/**
 * @param {string} token
 * @param {string} [userAgent]
 */
export function ghHeaders(token, userAgent = "morgan-travelers") {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Parse session cookie value → { token, login, avatar, name, exp }
 * @param {string | null | undefined} cookieHeader
 */
export function parseSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const parts = String(cookieHeader).split(/;\s*/);
  const raw = parts
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  try {
    const val = decodeURIComponent(raw.slice(COOKIE_NAME.length + 1));
    const data = JSON.parse(b64decode(val));
    if (!data?.token || !data?.login) return null;
    if (data.exp && Date.now() > Number(data.exp)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object} session
 * @param {{ secure?: boolean, maxAgeSec?: number }} [opts]
 */
export function sessionCookieHeader(session, opts = {}) {
  const maxAge = opts.maxAgeSec ?? 60 * 60 * 24 * 14; // 14d
  const payload = b64encode(
    JSON.stringify({
      token: session.token,
      login: session.login,
      avatar: session.avatar || "",
      name: session.name || "",
      exp: Date.now() + maxAge * 1000,
    }),
  );
  const secure = opts.secure !== false;
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(payload)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearSessionCookieHeader(opts = {}) {
  const secure = opts.secure !== false;
  const bits = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

/**
 * @param {string} token
 */
export async function fetchGithubUser(token) {
  const res = await fetch(`${GH_API}/user`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await res.text() };
  }
  const u = await res.json();
  return {
    ok: true,
    login: u.login,
    name: u.name || u.login,
    avatar: u.avatar_url || "",
    html_url: u.html_url || "",
  };
}

/**
 * Open PR with pending draft.
 *
 * mode "bot": push branch on upstream with bot/PAT token
 * mode "oauth": fork (if needed) → branch on user fork → PR to upstream
 *
 * @param {{
 *   token: string,
 *   draft: object,
 *   mode: "bot" | "oauth",
 *   repo?: string,
 *   base?: string,
 *   userLogin?: string,
 * }} opts
 */
export async function openOverridesPullRequest(opts) {
  const token = opts.token;
  const draft = opts.draft;
  const mode = opts.mode === "oauth" ? "oauth" : "bot";
  const repo = String(opts.repo || DEFAULT_OVERRIDES_REPO).trim();
  const base = String(opts.base || "main").trim() || "main";
  if (!token || !repo.includes("/")) {
    return { ok: false, skipped: true };
  }
  const [upstreamOwner, upstreamName] = repo.split("/");
  const headers = ghHeaders(token);

  const safeId = String(draft.id || `path_${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
  const branch = `contrib/${safeId}`.slice(0, 100);
  const filePath = `pending/${safeId}.json`;
  const contentPath = filePath.split("/").map(encodeURIComponent).join("/");
  const bodyJson = JSON.stringify(draft, null, 2) + "\n";
  const contentB64 = b64encode(bodyJson);

  try {
    // Resolve user login for oauth
    let login = opts.userLogin || "";
    if (mode === "oauth") {
      if (!login) {
        const me = await fetchGithubUser(token);
        if (!me.ok) {
          return { ok: false, error: `auth user: ${me.status}`, need_login: true };
        }
        login = me.login;
      }
    }

    // Upstream main SHA
    const refRes = await fetch(
      `${GH_API}/repos/${upstreamOwner}/${upstreamName}/git/ref/heads/${encodeURIComponent(base)}`,
      { headers },
    );
    if (!refRes.ok) {
      const t = await refRes.text();
      return {
        ok: false,
        error: `base ref ${base}: ${refRes.status} ${t.slice(0, 200)}`,
      };
    }
    const baseSha = (await refRes.json())?.object?.sha;
    if (!baseSha) return { ok: false, error: "No base SHA" };

    /** Where we push the branch */
    let headOwner = upstreamOwner;
    let headRepo = upstreamName;

    if (mode === "oauth") {
      // Ensure fork exists
      const forkCheck = await fetch(
        `${GH_API}/repos/${login}/${upstreamName}`,
        { headers },
      );
      if (forkCheck.status === 404) {
        const forkRes = await fetch(
          `${GH_API}/repos/${upstreamOwner}/${upstreamName}/forks`,
          { method: "POST", headers, body: JSON.stringify({}) },
        );
        if (!forkRes.ok) {
          const t = await forkRes.text();
          return {
            ok: false,
            error: `fork: ${forkRes.status} ${t.slice(0, 300)}`,
          };
        }
        // Wait for fork to be ready
        for (let i = 0; i < 12; i++) {
          await sleep(1500);
          const ready = await fetch(`${GH_API}/repos/${login}/${upstreamName}`, {
            headers,
          });
          if (ready.ok) break;
          if (i === 11) {
            return { ok: false, error: "Fork created but not ready yet — retry submit" };
          }
        }
      } else if (!forkCheck.ok) {
        const t = await forkCheck.text();
        return {
          ok: false,
          error: `fork check: ${forkCheck.status} ${t.slice(0, 200)}`,
        };
      }
      headOwner = login;
      headRepo = upstreamName;

      // Best-effort: update fork default branch from upstream
      await fetch(
        `${GH_API}/repos/${login}/${upstreamName}/merge-upstream`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ branch: base }),
        },
      ).catch(() => null);
    }

    // Create branch on head repo from upstream main sha
    const branchRes = await fetch(
      `${GH_API}/repos/${headOwner}/${headRepo}/git/refs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        }),
      },
    );
    if (!branchRes.ok && branchRes.status !== 422) {
      // 422 = already exists
      const t = await branchRes.text();
      // If sha mismatch on fork, try fork's own main
      if (mode === "oauth") {
        const forkRef = await fetch(
          `${GH_API}/repos/${headOwner}/${headRepo}/git/ref/heads/${encodeURIComponent(base)}`,
          { headers },
        );
        if (forkRef.ok) {
          const forkSha = (await forkRef.json())?.object?.sha;
          if (forkSha) {
            const retry = await fetch(
              `${GH_API}/repos/${headOwner}/${headRepo}/git/refs`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  ref: `refs/heads/${branch}`,
                  sha: forkSha,
                }),
              },
            );
            if (!retry.ok && retry.status !== 422) {
              return {
                ok: false,
                error: `branch: ${retry.status} ${(await retry.text()).slice(0, 200)}`,
              };
            }
          }
        } else {
          return {
            ok: false,
            error: `branch: ${branchRes.status} ${t.slice(0, 200)}`,
          };
        }
      } else {
        return {
          ok: false,
          error: `branch: ${branchRes.status} ${t.slice(0, 200)}`,
        };
      }
    }

    // Put file
    let existingSha;
    const getFileRes = await fetch(
      `${GH_API}/repos/${headOwner}/${headRepo}/contents/${contentPath}?ref=${encodeURIComponent(branch)}`,
      { headers },
    );
    if (getFileRes.ok) {
      existingSha = (await getFileRes.json()).sha;
    }

    const committer =
      mode === "oauth" && login
        ? { name: login, email: `${login}@users.noreply.github.com` }
        : {
            name: "MORGAN Travelers",
            email: "contributions@morgandev.cc",
          };

    const putBody = {
      message: `contrib: ${draft.agency} ${draft.route_short_name} (${safeId})`,
      content: contentB64,
      branch,
      committer,
    };
    if (existingSha) putBody.sha = existingSha;

    const putRes = await fetch(
      `${GH_API}/repos/${headOwner}/${headRepo}/contents/${contentPath}`,
      { method: "PUT", headers, body: JSON.stringify(putBody) },
    );
    if (!putRes.ok) {
      return {
        ok: false,
        error: `put file: ${putRes.status} ${(await putRes.text()).slice(0, 300)}`,
      };
    }

    // PR head
    const headRef =
      mode === "oauth" ? `${login}:${branch}` : `${upstreamOwner}:${branch}`;

    let prUrl = "";
    let prNumber = 0;
    const prList = await fetch(
      `${GH_API}/repos/${upstreamOwner}/${upstreamName}/pulls?head=${encodeURIComponent(headRef)}&state=open`,
      { headers },
    );
    if (prList.ok) {
      const open = await prList.json();
      if (Array.isArray(open) && open[0]?.html_url) {
        prUrl = open[0].html_url;
        prNumber = open[0].number;
      }
    }

    if (!prUrl) {
      const prRes = await fetch(
        `${GH_API}/repos/${upstreamOwner}/${upstreamName}/pulls`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: `[path] ${draft.agency} ${draft.route_short_name} — ${safeId}`,
            head: mode === "oauth" ? `${login}:${branch}` : branch,
            base,
            body: [
              `## Path contribution`,
              ``,
              `| | |`,
              `|---|---|`,
              `| **Mode** | ${mode === "oauth" ? "OAuth (contributor account)" : "Bot account"} |`,
              `| **Route** | ${draft.agency} ${draft.route_short_name} |`,
              `| **From** | ${(draft.from_match || []).join(", ")} |`,
              `| **To** | ${(draft.to_match || []).join(", ")} |`,
              `| **Points** | ${draft.coordinates?.length || 0} |`,
              `| **Contributor** | ${draft.contributor || login || "—"} |`,
              ``,
              draft.notes ? `### Notes\n${draft.notes}\n` : "",
              `### Review`,
              `1. Inspect \`${filePath}\``,
              `2. \`node scripts/merge-pending.mjs ${filePath}\` or Actions → Merge pending`,
              `3. Merge PR / publish \`bus-shapes.json\``,
              ``,
              `_Submitted via MORGAN Travelers._`,
            ].join("\n"),
          }),
        },
      );
      if (!prRes.ok) {
        return {
          ok: false,
          error: `create PR: ${prRes.status} ${(await prRes.text()).slice(0, 300)}`,
          branch,
          file: filePath,
        };
      }
      const pr = await prRes.json();
      prUrl = pr.html_url || "";
      prNumber = pr.number || 0;
    }

    return {
      ok: true,
      pr_url: prUrl,
      pr_number: prNumber,
      branch,
      file: filePath,
      repo: `${upstreamOwner}/${upstreamName}`,
      mode,
      author: mode === "oauth" ? login : "bot",
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
